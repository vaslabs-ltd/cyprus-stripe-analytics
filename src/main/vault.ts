/**
 * Encryption for the last session and, optionally, the Stripe key.
 *
 * - Setting a PIN creates an X25519 key pair. Sessions are sealed to the public key (ephemeral ECDH,
 *   HKDF-SHA256, AES-256-GCM), so the app can save a session at any time without asking for the PIN.
 * - The private key is sealed with a key derived (scrypt) from the PIN *and* the Stripe key: opening
 *   a session needs both.
 * - Optionally the Stripe key itself is sealed with a key derived from the PIN alone (it can't also
 *   depend on itself). Then everything depends on the PIN only.
 *
 * The PIN is never stored. A 4–8 digit PIN is short: scrypt makes each guess slow, but someone with
 * a copy of the files and time can still try every PIN offline.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scrypt,
  type KeyObject,
} from 'node:crypto';

export const isValidPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

/** AES-256-GCM output, base64. */
export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

/** scrypt parameters; the salt is base64. */
export interface Kdf {
  salt: string;
  N: number;
  r: number;
  p: number;
}

export type KdfCost = Omit<Kdf, 'salt'>;
/** ~128 MiB and a few hundred ms per guess on a laptop. */
export const DEFAULT_COST: KdfCost = { N: 2 ** 17, r: 8, p: 1 };

export interface Lock {
  version: 1;
  /** X25519 public key, SPKI DER, base64. Sessions are sealed to it. */
  publicKey: string;
  /** The private key (PKCS#8 DER), sealed with a key from the PIN and the Stripe key. */
  privateKey: Sealed & { kdf: Kdf };
  /** The Stripe key, sealed with a key from the PIN alone; only when the user chose to encrypt it. */
  stripeKey?: Sealed & { kdf: Kdf };
}

/** A session sealed to the lock's public key. */
export interface SealedSession extends Sealed {
  version: 1;
  /** Ephemeral X25519 public key, SPKI DER, base64. */
  epk: string;
}

export class WrongPinError extends Error {
  constructor() {
    super('Wrong PIN.');
  }
}

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const AAD_PRIVATE = Buffer.from('stripe-analytics private key v1');
const AAD_STRIPE = Buffer.from('stripe-analytics stripe key v1');
const AAD_SESSION = Buffer.from('stripe-analytics session v1');

function deriveKey(secret: string, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret, unb64(kdf.salt), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

const newKdf = (cost: KdfCost): Kdf => ({ salt: b64(randomBytes(16)), ...cost });

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const data = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}

/** Throws WrongPinError when the key is wrong or the data was changed. */
export function open(key: Buffer, s: Sealed, aad: Buffer): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, unb64(s.iv));
    d.setAAD(aad);
    d.setAuthTag(unb64(s.tag));
    return Buffer.concat([d.update(unb64(s.data)), d.final()]);
  } catch {
    throw new WrongPinError();
  }
}

/** The secret behind the private key: PIN and Stripe key together. */
const sessionSecret = (pin: string, stripeKey: string) => `${pin}\u0000${stripeKey}`;

async function sealPrivateKey(privateKey: KeyObject, pin: string, stripeKey: string, cost: KdfCost): Promise<Lock['privateKey']> {
  const kdf = newKdf(cost);
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  return { ...seal(await deriveKey(sessionSecret(pin, stripeKey), kdf), der, AAD_PRIVATE), kdf };
}

async function sealStripeKey(pin: string, stripeKey: string, cost: KdfCost): Promise<Lock['stripeKey']> {
  const kdf = newKdf(cost);
  return { ...seal(await deriveKey(pin, kdf), Buffer.from(stripeKey, 'utf8'), AAD_STRIPE), kdf };
}

function checkPin(pin: string): void {
  if (!isValidPin(pin)) throw new Error('The PIN must be 4 to 8 digits.');
}

/** A new lock (new key pair) for this PIN and Stripe key. */
export async function createLock(pin: string, stripeKey: string, encryptStripeKey: boolean, cost: KdfCost = DEFAULT_COST): Promise<{ lock: Lock; privateKey: KeyObject }> {
  checkPin(pin);
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const lock: Lock = {
    version: 1,
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: await sealPrivateKey(privateKey, pin, stripeKey, cost),
  };
  if (encryptStripeKey) lock.stripeKey = await sealStripeKey(pin, stripeKey, cost);
  return { lock, privateKey };
}

/**
 * Opens the lock with the PIN. The Stripe key comes from the lock when it's encrypted there, else
 * it must be given. Throws WrongPinError for a wrong PIN (or a Stripe key other than the lock's).
 */
export async function unlock(lock: Lock, pin: string, plainStripeKey?: string): Promise<{ stripeKey: string; privateKey: KeyObject }> {
  if (!isValidPin(pin)) throw new WrongPinError();
  let stripeKey = plainStripeKey;
  if (lock.stripeKey) stripeKey = open(await deriveKey(pin, lock.stripeKey.kdf), lock.stripeKey, AAD_STRIPE).toString('utf8');
  if (!stripeKey) throw new Error('No Stripe key to unlock the session with.');
  const der = open(await deriveKey(sessionSecret(pin, stripeKey), lock.privateKey.kdf), lock.privateKey, AAD_PRIVATE);
  return { stripeKey, privateKey: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }) };
}

/** The same key pair under a new PIN and/or Stripe key, with the Stripe key encrypted or not. */
export async function rewrap(lock: Lock, privateKey: KeyObject, pin: string, stripeKey: string, encryptStripeKey: boolean, cost: KdfCost = DEFAULT_COST): Promise<Lock> {
  checkPin(pin);
  const next: Lock = { version: 1, publicKey: lock.publicKey, privateKey: await sealPrivateKey(privateKey, pin, stripeKey, cost) };
  if (encryptStripeKey) next.stripeKey = await sealStripeKey(pin, stripeKey, cost);
  return next;
}

function sessionKey(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), AAD_SESSION, 32));
}

/** Seals data to the lock's public key: no PIN needed. */
export function sealSession(lock: Lock, plaintext: Buffer): SealedSession {
  const recipient = unb64(lock.publicKey);
  const eph = generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: recipient, format: 'der', type: 'spki' }) });
  return { version: 1, epk: b64(epk), ...seal(sessionKey(shared, epk, recipient), plaintext, AAD_SESSION) };
}

export function openSession(privateKey: KeyObject, s: SealedSession): Buffer {
  const epk = unb64(s.epk);
  const recipient = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: epk, format: 'der', type: 'spki' }) });
  return open(sessionKey(shared, epk, recipient), s, AAD_SESSION);
}
