/**
 * The last session (reports and how they were being viewed), kept encrypted so the app can be
 * restarted and carry on. Nothing is kept without a PIN. See vault.ts for the encryption.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { KeyObject } from 'node:crypto';
import type { SessionStatus } from '../shared/types';
import { createLock, DEFAULT_COST, openSession, rewrap, sealSession, unlock, WrongPinError, type KdfCost, type Lock, type SealedSession } from './vault';

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
/** A session bigger than this isn't saved (a report of a few years is a few MB). */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

export class SessionVault {
  /** While unlocked: the PIN (to re-encrypt after a key change) and the private key. */
  private unlocked: { pin: string; privateKey: KeyObject } | null = null;
  /** The last session, decrypted, while unlocked (restored after a window reload without the PIN). */
  private current: unknown = null;

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
    return { pinSet: !!lock, encryptsKey: !!lock?.stripeKey, hasSession, unlocked: !!this.unlocked };
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
    return { stripeKey, session: this.current };
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
      return;
    }
    const current = opts.currentPin ?? '';
    const { privateKey } = await unlock(lock, current, opts.stripeKey).catch((e) => {
      throw e instanceof WrongPinError ? new Error('The current PIN is wrong.') : e;
    });
    const pin = opts.pin || current;
    await this.store.write(LOCK_FILE, JSON.stringify(await rewrap(lock, privateKey, pin, opts.stripeKey, opts.encryptStripeKey, this.cost)));
    if (!this.unlocked) this.current = await this.readSession(privateKey);
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

  /** Forgets everything: PIN, session and an encrypted Stripe key (e.g. the PIN was forgotten). */
  async reset(): Promise<void> {
    await this.store.remove(SESSION_FILE);
    await this.store.remove(LOCK_FILE);
    this.unlocked = null;
    this.current = null;
  }

  /** Locks again: the PIN is needed to see the session (and use an encrypted Stripe key). */
  lockNow(): void {
    this.unlocked = null;
    this.current = null;
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
