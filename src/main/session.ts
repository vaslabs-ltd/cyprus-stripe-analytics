/**
 * The last session (reports and how they were being viewed) and the company details of the
 * executive summary, kept encrypted so the app can be restarted and carry on. Nothing is kept
 * without a PIN. See vault.ts for the encryption.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { KeyObject } from 'node:crypto';
import type { SessionStatus } from '../shared/types';
import { AAD_COMPANY, createLock, DEFAULT_COST, openSession, rewrap, sealSession, unlock, WrongPinError, type KdfCost, type Lock, type SealedSession } from './vault';

/** Where the lock and the sealed session are kept. */
export interface Store {
  read(name: string): Promise<string | null>;
  write(name: string, data: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Files in a folder, readable only by the user. Writes go through a temp file, so a crash can't leave half a file. */
export const fileStore = (dir: string): Store => ({
  async read(name) {
    const f = path.join(dir, name);
    return existsSync(f) ? readFile(f, 'utf8') : null;
  },
  async write(name, data) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const f = path.join(dir, name);
    const tmp = `${f}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, f);
  },
  async remove(name) {
    await rm(path.join(dir, name), { force: true });
  },
});

/** In memory only (demo mode). */
export function memoryStore(): Store {
  const files = new Map<string, string>();
  return {
    read: async (name) => files.get(name) ?? null,
    write: async (name, data) => void files.set(name, data),
    remove: async (name) => void files.delete(name),
  };
}

export const LOCK_FILE = 'session-lock.json';
export const SESSION_FILE = 'last-session.json';
export const COMPANY_FILE = 'company.json';
/** A session bigger than this isn't saved (a report of a few years is a few MB). */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export class SessionVault {
  /** While unlocked: the PIN (to re-encrypt after a key change) and the private key. */
  private unlocked: { pin: string; privateKey: KeyObject } | null = null;
  /** The last session, decrypted, while unlocked (restored after a window reload without the PIN). */
  private current: unknown = null;
  /**
   * The company details: decrypted while unlocked, or (without a PIN) kept in memory for this run
   * only. Null when there are none (or while locked).
   */
  private companyDetails: unknown = null;

  constructor(
    private readonly store: Store,
    private readonly cost: KdfCost = DEFAULT_COST,
  ) {}

  private async lock(): Promise<Lock | null> {
    const raw = await this.store.read(LOCK_FILE);
    if (!raw) return null;
    try {
      const l = JSON.parse(raw) as Lock;
      return l?.version === 1 && l.publicKey && l.privateKey ? l : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<Omit<SessionStatus, 'available' | 'reason' | 'keyNotEncryptable'>> {
    const lock = await this.lock();
    const hasSession = !!lock && (await this.store.read(SESSION_FILE)) !== null;
    const hasCompany = !!lock && (await this.store.read(COMPANY_FILE)) !== null;
    return { pinSet: !!lock, encryptsKey: !!lock?.stripeKey, hasSession, hasCompany, unlocked: !!this.unlocked };
  }

  get isUnlocked(): boolean {
    return !!this.unlocked;
  }

  /** The Stripe key and last session, with the PIN. The Stripe key is the given one unless it's encrypted. */
  async unlock(pin: string, plainStripeKey?: string): Promise<{ stripeKey: string; session: unknown }> {
    const lock = await this.lock();
    if (!lock) throw new Error('No PIN is set.');
    const { stripeKey, privateKey } = await unlock(lock, pin, plainStripeKey);
    this.unlocked = { pin, privateKey };
    this.current = await this.readSession(privateKey);
    this.companyDetails = await this.readCompany(privateKey);
    return { stripeKey, session: this.current };
  }

  private async readCompany(privateKey: KeyObject): Promise<unknown> {
    const raw = await this.store.read(COMPANY_FILE);
    if (!raw) return null;
    try {
      return JSON.parse(openSession(privateKey, JSON.parse(raw) as SealedSession, AAD_COMPANY).toString('utf8'));
    } catch {
      await this.store.remove(COMPANY_FILE);
      return null;
    }
  }

  /**
   * The company details. `kept`: saved encrypted (a PIN is set); `locked`: a PIN is set but hasn't
   * been entered, so they can't be read (or changed) yet.
   */
  async company(): Promise<{ company: unknown; kept: boolean; locked: boolean }> {
    const lock = await this.lock();
    if (!lock) return { company: this.companyDetails, kept: false, locked: false };
    if (!this.unlocked) return { company: null, kept: true, locked: true };
    return { company: this.companyDetails, kept: true, locked: false };
  }

  /**
   * Saves the company details, encrypted, when a PIN is set; without one they're kept in memory
   * for this run only. Refused while locked, so details that couldn't be read aren't overwritten.
   * Returns whether they were saved to disk.
   */
  async saveCompany(company: unknown): Promise<boolean> {
    const lock = await this.lock();
    if (lock && !this.unlocked) throw new Error('Unlock with the PIN first: the company details are encrypted with it.');
    this.companyDetails = company;
    if (!lock) return false;
    await this.writeCompany(lock);
    return true;
  }

  private async writeCompany(lock: Lock): Promise<void> {
    if (this.companyDetails === null) return;
    const sealed = sealSession(lock, Buffer.from(JSON.stringify(this.companyDetails), 'utf8'), AAD_COMPANY);
    await this.store.write(COMPANY_FILE, JSON.stringify(sealed));
  }

  private async readSession(privateKey: KeyObject): Promise<unknown> {
    const raw = await this.store.read(SESSION_FILE);
    if (!raw) return null;
    try {
      return JSON.parse(gunzipSync(openSession(privateKey, JSON.parse(raw) as SealedSession)).toString('utf8'));
    } catch {
      // Unreadable (damaged, or from an older lock): start without it.
      await this.store.remove(SESSION_FILE);
      return null;
    }
  }

  /** The decrypted last session, while unlocked. */
  restore(): unknown {
    return this.unlocked ? this.current : null;
  }

  /** Seals and saves the session; nothing is kept without a PIN. Returns whether it was saved. */
  async save(session: unknown): Promise<boolean> {
    const lock = await this.lock();
    if (!lock) return false;
    const data = gzipSync(Buffer.from(JSON.stringify(session), 'utf8'));
    if (data.length > MAX_SESSION_BYTES) return false;
    await this.store.write(SESSION_FILE, JSON.stringify(sealSession(lock, data)));
    if (this.unlocked) this.current = session;
    return true;
  }

  /**
   * Sets the PIN, changes it, or turns encrypting the Stripe key on or off. With a PIN already set,
   * the current PIN is needed. Keeps the saved session.
   */
  async setPin(opts: { currentPin?: string; pin?: string; encryptStripeKey: boolean; stripeKey: string }): Promise<void> {
    const lock = await this.lock();
    if (!lock) {
      if (!opts.pin) throw new Error('Enter a PIN.');
      const { lock: created, privateKey } = await createLock(opts.pin, opts.stripeKey, opts.encryptStripeKey, this.cost);
      await this.store.write(LOCK_FILE, JSON.stringify(created));
      this.unlocked = { pin: opts.pin, privateKey };
      // Details entered before there was a PIN are kept from now on.
      await this.writeCompany(created);
      return;
    }
    const current = opts.currentPin ?? '';
    const { privateKey } = await unlock(lock, current, opts.stripeKey).catch((e) => {
      throw e instanceof WrongPinError ? new Error('The current PIN is wrong.') : e;
    });
    const pin = opts.pin || current;
    await this.store.write(LOCK_FILE, JSON.stringify(await rewrap(lock, privateKey, pin, opts.stripeKey, opts.encryptStripeKey, this.cost)));
    if (!this.unlocked) {
      this.current = await this.readSession(privateKey);
      this.companyDetails = await this.readCompany(privateKey);
    }
    this.unlocked = { pin, privateKey };
  }

  /** Removes the PIN and the saved session, with the current PIN. Returns the Stripe key (decrypted if it was encrypted). */
  async removePin(currentPin: string, plainStripeKey?: string): Promise<string> {
    const lock = await this.lock();
    if (!lock) throw new Error('No PIN is set.');
    const { stripeKey } = await unlock(lock, currentPin, plainStripeKey).catch((e) => {
      throw e instanceof WrongPinError ? new Error('The current PIN is wrong.') : e;
    });
    await this.reset();
    return stripeKey;
  }

  /**
   * Forgets everything on disk: PIN, session, company details and an encrypted Stripe key (e.g. the
   * PIN was forgotten). Company details already unlocked stay in memory for the rest of the run.
   */
  async reset(): Promise<void> {
    await this.store.remove(SESSION_FILE);
    await this.store.remove(COMPANY_FILE);
    await this.store.remove(LOCK_FILE);
    this.unlocked = null;
    this.current = null;
  }

  /** Locks again: the PIN is needed to see the session (and use an encrypted Stripe key). */
  lockNow(): void {
    this.unlocked = null;
    this.current = null;
    this.companyDetails = null;
  }

  /**
   * A new Stripe key: the saved session belonged to the old one and is deleted. While unlocked, the
   * PIN is kept (re-encrypted for the new key); otherwise it can't be, and is removed.
   * Returns whether the PIN was kept and whether the new key is stored encrypted.
   */
  async stripeKeyChanged(newKey: string): Promise<{ keptPin: boolean; encryptsKey: boolean }> {
    const lock = await this.lock();
    await this.store.remove(SESSION_FILE);
    this.current = null;
    if (!lock) return { keptPin: false, encryptsKey: false };
    if (!this.unlocked) {
      await this.reset();
      return { keptPin: false, encryptsKey: false };
    }
    const encryptsKey = !!lock.stripeKey;
    await this.store.write(LOCK_FILE, JSON.stringify(await rewrap(lock, this.unlocked.privateKey, this.unlocked.pin, newKey, encryptsKey, this.cost)));
    return { keptPin: true, encryptsKey };
  }
}
