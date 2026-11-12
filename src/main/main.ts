import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type Stripe from 'stripe';
import type { IpcResult, KeyStatus, ReportView, RevenueQuery, RevenueReport, SessionStatus, Settings, VatQuery, VatReport } from '../shared/types';
import {
  checkKeyAccess,
  createStripeClient,
  isRestrictedKey,
  listProducts,
  revenueByCountry,
  stripeInvoiceSource,
  stripeServiceSource,
  vatReport,
  type InvoiceSource,
  type ServiceSource,
} from './stripe';
import { demoInvoiceSource, demoServiceSource, isDemoKey } from './demo';
import { vatReportToCsv } from './vat';
import { parseView, regroupContractors, reportToCsv, type ContractorMap } from './analytics';
import { FxRateStore } from './fx';
import { APP_DIR, cacheDir } from './paths';
import { loadSettings, normalizeSettings, saveSettings } from './settings';
import { fileStore, memoryStore, SessionVault } from './session';
import { isValidPin, WrongPinError } from './vault';

/**
 * The app's config dir: ~/.config/vaslabs-ltd/stripe-analytics on Linux,
 * %APPDATA%\vaslabs-ltd\stripe-analytics on Windows.
 */
function configDir(): string {
  return path.join(app.getPath('appData'), APP_DIR);
}
const configEnvFile = () => path.join(configDir(), '.env');
/** User preferences (Options tab), e.g. ~/.config/vaslabs-ltd/stripe-analytics/settings.json. */
const settingsFile = () => path.join(configDir(), 'settings.json');

/**
 * Load .env from the first location that exists:
 *  1. the current working directory (dev: `npm start`)
 *  2. the config dir (where a key entered in the app is saved)
 *  3. the old location, Electron's userData dir (e.g. ~/.config/Stripe Analytics/.env)
 * A STRIPE_PASSKEY already in the environment wins over all of them.
 */
/**
 * Where the key in use came from: the config .env (or entered in the app), the PIN-encrypted copy,
 * or somewhere the app doesn't manage (an environment variable, another .env file). Only a key the
 * app manages can be encrypted: otherwise a plain copy would stay behind.
 */
let keySource: 'config' | 'encrypted' | { other: string } | null = null;

function loadEnv(): void {
  const candidates = [path.join(process.cwd(), '.env'), configEnvFile(), path.join(app.getPath('userData'), '.env')];
  const found = candidates.find((p) => existsSync(p));
  const fromEnvironment = !!process.env.STRIPE_PASSKEY;
  if (found) dotenv.config({ path: found, quiet: true });
  if (fromEnvironment) keySource = { other: 'the STRIPE_PASSKEY environment variable' };
  else if (process.env.STRIPE_PASSKEY) keySource = found === configEnvFile() ? 'config' : { other: found! };
  // Demo mode only starts from the key dialog, never from a saved or exported key.
  if (isDemoKey(process.env.STRIPE_PASSKEY)) delete process.env.STRIPE_PASSKEY;
}

/** Save the key to the config dir's .env (owner-only permissions), keeping any other lines. Null removes it. */
async function saveKey(key: string | null): Promise<string> {
  const file = configEnvFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? (await readFile(file, 'utf8')).split(/\r?\n/) : [];
  const kept = existing.filter((l) => l.trim() && !/^\s*(export\s+)?STRIPE_PASSKEY\s*=/.test(l));
  const lines = key ? [...kept, `STRIPE_PASSKEY=${key}`] : kept;
  await writeFile(file, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
  await chmod(file, 0o600); // writeFile's mode only applies when it creates the file
  return file;
}

let stripe: Stripe | null = null;

/**
 * Demo mode (key `rk_demo`): generated invoices instead of Stripe. Kept in memory only, so a
 * restart is back on the real key, and it uses its own FX cache (see getFxStore).
 */
let demo = false;
let demoSource: InvoiceSource | null = null;

function getInvoices(): InvoiceSource {
  if (demo) return (demoSource ??= demoInvoiceSource());
  stripe ??= createStripeClient(process.env.STRIPE_PASSKEY);
  return stripeInvoiceSource(stripe);
}

function getServices(): ServiceSource {
  if (demo) return demoServiceSource();
  stripe ??= createStripeClient(process.env.STRIPE_PASSKEY);
  return stripeServiceSource(stripe);
}

let fxStore: FxRateStore | null = null;
let demoFxStore: FxRateStore | null = null;
/**
 * Dev: the committed data/fx-rates.csv in the project. Packaged app: a copy in the user's cache
 * dir (see cacheDir; the app bundle is read-only). The copy is seeded on first use from the
 * cache the app used before (in Electron's userData dir) if there is one, else the bundled file.
 */
function getFxStore(): FxRateStore {
  if (demo) return getDemoFxStore();
  if (fxStore) return fxStore;
  let file = process.env.FX_RATES_FILE || path.join(app.getAppPath(), 'data', 'fx-rates.csv');
  if (!process.env.FX_RATES_FILE && app.isPackaged) {
    file = path.join(cacheDir(process.platform, process.env, app.getPath('home')), 'fx-rates.csv');
    if (!existsSync(file)) {
      const seed = [path.join(app.getPath('userData'), 'fx-rates.csv'), path.join(app.getAppPath(), 'data', 'fx-rates.csv')].find((f) =>
        existsSync(f),
      );
      if (seed) {
        mkdirSync(path.dirname(file), { recursive: true });
        copyFileSync(seed, file);
      }
    }
  }
  fxStore = new FxRateStore(file);
  return fxStore;
}

/**
 * Demo mode's FX cache lives in its own folder (<cache dir>/demo/fx-rates.csv), seeded from the
 * bundled file, so demo runs never add rows to the real cache or to the committed data file.
 */
function getDemoFxStore(): FxRateStore {
  if (demoFxStore) return demoFxStore;
  const file = path.join(cacheDir(process.platform, process.env, app.getPath('home')), 'demo', 'fx-rates.csv');
  const bundled = path.join(app.getAppPath(), 'data', 'fx-rates.csv');
  if (!existsSync(file) && existsSync(bundled)) {
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(bundled, file);
  }
  demoFxStore = new FxRateStore(file);
  return demoFxStore;
}

/**
 * Demo mode keeps settings in memory, starting from the saved VAT options with no contractors, so
 * demo contractors and demo product IDs never end up in the real settings.json.
 */
let demoSettings: Settings | null = null;

async function getSettings(): Promise<Settings> {
  if (!demo) return loadSettings(settingsFile());
  return (demoSettings ??= { ...(await loadSettings(settingsFile())), contractors: [], productContractors: {} });
}

async function putSettings(raw: unknown): Promise<Settings> {
  if (!demo) return saveSettings(settingsFile(), raw);
  return (demoSettings = normalizeSettings(raw));
}

/**
 * The PIN-encrypted last session: files in the config dir, or in memory in demo mode (a fresh one
 * each time demo mode starts, so demo sessions never reach the disk or a real session).
 */
const SESSION_COST = process.env.STRIPE_ANALYTICS_TEST_KDF ? { N: 2 ** 10, r: 8, p: 1 } : undefined;
let realVault: SessionVault | null = null;
let demoVault: SessionVault | null = null;
const vault = () => (demo ? (demoVault ??= new SessionVault(memoryStore(), SESSION_COST)) : (realVault ??= new SessionVault(fileStore(configDir()), SESSION_COST)));

async function sessionStatus(): Promise<SessionStatus> {
  const st = await vault().status();
  const key = process.env.STRIPE_PASSKEY;
  const usable = demo || isRestrictedKey(key);
  const keyNotEncryptable = demo
    ? 'Demo mode has no Stripe key to encrypt.'
    : keySource && typeof keySource === 'object'
      ? `The key is read from ${keySource.other}. Remove it there and enter it with "Stripe key…" to encrypt it.`
      : null;
  return {
    ...st,
    available: usable || st.pinSet,
    reason: usable || st.pinSet ? undefined : 'Enter a Stripe key first: the session is encrypted with the PIN and the key together.',
    keyNotEncryptable,
  };
}

/** A small pause after a wrong PIN, so guessing in the app is slow. */
const wrongPinDelay = () => new Promise((r) => setTimeout(r, 1000));

async function wrap<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Stripe Analytics',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Never navigate away or open new windows from the renderer.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('key-status', async (): Promise<KeyStatus> => {
  const key = process.env.STRIPE_PASSKEY;
  const locked = !demo && !key && (await vault().status()).encryptsKey;
  const state = demo ? 'demo' : locked ? 'locked' : !key ? 'missing' : isRestrictedKey(key) ? 'ok' : 'invalid';
  return { state, configFile: configEnvFile() };
});

/** After a key change, reload the window so no report from the previous key stays on screen. */
const reloadSoon = (sender: Electron.WebContents) => setTimeout(() => sender.reload(), 0);

ipcMain.handle('save-key', async (event, raw: unknown) => {
  const res = await wrap(async () => {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (isDemoKey(key)) {
      demo = true; // not saved, not checked with Stripe; the saved real key stays as it is
      return null;
    }
    const client = createStripeClient(key); // throws unless it's a restricted rk_ key
    await checkKeyAccess(client);
    demo = false;
    // The last session belonged to the old key. The PIN is kept only if it was entered this run.
    const { encryptsKey } = await vault().stripeKeyChanged(key);
    const file = await saveKey(encryptsKey ? null : key);
    process.env.STRIPE_PASSKEY = key;
    keySource = encryptsKey ? 'encrypted' : 'config';
    stripe = client;
    return encryptsKey ? null : file;
  });
  if (res.ok) reloadSoon(event.sender);
  return res;
});

/** Contractors and product assignments from Options. */
async function contractorMap(): Promise<ContractorMap> {
  const { contractors, productContractors } = await getSettings();
  return { names: new Map(contractors.map((c) => [c.id, c.name])), byProduct: new Map(Object.entries(productContractors)) };
}

ipcMain.handle('revenue-by-country', (event, query: RevenueQuery) =>
  wrap(async () => revenueByCountry(getInvoices(), getFxStore(), query ?? {}, (p) => event.sender.send('progress', p), getServices(), await contractorMap())),
);

ipcMain.handle('regroup-contractors', (_event, report: RevenueReport) => wrap(async () => regroupContractors(report, await contractorMap())));

async function saveCsv(sender: Electron.WebContents, title: string, defaultPath: string, csv: () => string): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const opts = { title, defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, csv(), 'utf8');
  return res.filePath;
}

ipcMain.handle('export-csv', (event, report: RevenueReport, view: ReportView, breakdown?: unknown) =>
  wrap(() => {
    const { grouping, eur } = parseView(view);
    const by = grouping === 'contractor' && (breakdown === 'product' || breakdown === 'client') ? breakdown : 'country';
    const what = grouping === 'contractor' && by !== 'country' ? `contractor-and-${by}` : grouping;
    return saveCsv(
      event.sender,
      `Export revenue by ${what.replace(/-/g, ' ')}`,
      `${demo ? 'demo-' : ''}revenue-by-${what}${eur ? '-eur' : ''}-${new Date().toISOString().slice(0, 10)}.csv`,
      () => reportToCsv(report, view, by),
    );
  }),
);

ipcMain.handle('vat-report', (event, query: VatQuery) =>
  wrap(async () => {
    const { vatFetch } = await getSettings();
    return vatReport(getInvoices(), getFxStore(), query, (p) => event.sender.send('progress', p), vatFetch);
  }),
);

ipcMain.handle('get-settings', () => wrap(async () => ({ settings: await getSettings(), file: demo ? null : settingsFile() })));
ipcMain.handle('save-settings', (_event, raw: unknown) => wrap(() => putSettings(raw)));
ipcMain.handle('list-products', () => wrap(() => listProducts(getServices())));

ipcMain.handle('session-status', () => sessionStatus());

ipcMain.handle('unlock-session', (_event, pin: unknown) =>
  wrap(async () => {
    try {
      const { stripeKey, session } = await vault().unlock(String(pin ?? ''), demo ? 'rk_demo' : process.env.STRIPE_PASSKEY);
      if (!demo && !process.env.STRIPE_PASSKEY) {
        process.env.STRIPE_PASSKEY = stripeKey;
        keySource = 'encrypted';
        stripe = null;
      }
      return session;
    } catch (e) {
      if (e instanceof WrongPinError) await wrongPinDelay();
      throw e;
    }
  }),
);

ipcMain.handle('restore-session', () => vault().restore());
ipcMain.handle('save-session', async (_event, session: unknown) => {
  if (!session || typeof session !== 'object' || (session as { version?: unknown }).version !== 1) return false;
  return vault().save(session).catch(() => false);
});

/** The key the PIN is combined with: the real key, or a fixed one in demo mode. */
function currentKey(): string {
  if (demo) return 'rk_demo';
  const key = process.env.STRIPE_PASSKEY;
  if (!isRestrictedKey(key)) throw new Error('Enter a Stripe key first: the session is encrypted with the PIN and the key together.');
  return key;
}

ipcMain.handle('set-pin', (_event, opts: { currentPin?: unknown; pin?: unknown; encryptStripeKey?: unknown }) =>
  wrap(async () => {
    const pin = typeof opts?.pin === 'string' && opts.pin ? opts.pin : undefined;
    if (pin !== undefined && !isValidPin(pin)) throw new Error('The PIN must be 4 to 8 digits.');
    const status = await sessionStatus();
    const encrypt = opts?.encryptStripeKey === true;
    if (encrypt && status.keyNotEncryptable) throw new Error(status.keyNotEncryptable);
    const key = currentKey();
    const currentPin = typeof opts?.currentPin === 'string' ? opts.currentPin : undefined;
    try {
      await vault().setPin({ currentPin, pin, encryptStripeKey: encrypt, stripeKey: key });
    } catch (e) {
      if (/current PIN is wrong/.test(String(e))) await wrongPinDelay();
      throw e;
    }
    if (!demo) {
      // An encrypted key leaves the .env file; a key no longer encrypted goes back to it.
      if (encrypt) await saveKey(null);
      else if (keySource === 'encrypted') await saveKey(key);
      if (encrypt || keySource === 'encrypted') keySource = encrypt ? 'encrypted' : 'config';
    }
    return sessionStatus();
  }),
);

ipcMain.handle('remove-pin', (_event, currentPin: unknown) =>
  wrap(async () => {
    try {
      const key = await vault().removePin(String(currentPin ?? ''), demo ? 'rk_demo' : process.env.STRIPE_PASSKEY);
      if (!demo && keySource === 'encrypted') {
        await saveKey(key);
        keySource = 'config';
      }
    } catch (e) {
      if (/current PIN is wrong/.test(String(e))) await wrongPinDelay();
      throw e;
    }
    return sessionStatus();
  }),
);

ipcMain.handle('reset-pin', () =>
  wrap(async () => {
    const encrypted = (await vault().status()).encryptsKey;
    await vault().reset();
    // An encrypted key is gone with the PIN: the key dialog asks for it again.
    if (encrypted && !demo) {
      delete process.env.STRIPE_PASSKEY;
      keySource = null;
      stripe = null;
    }
    return null;
  }),
);

ipcMain.handle('lock-now', async (event) => {
  vault().lockNow();
  if (!demo && keySource === 'encrypted') {
    delete process.env.STRIPE_PASSKEY;
    stripe = null;
  }
  reloadSoon(event.sender);
});

ipcMain.handle('export-vat-csv', (event, report: VatReport) =>
  wrap(() =>
    saveCsv(event.sender, 'Export Cyprus VAT report', `${demo ? 'demo-' : ''}cyprus-vat-${report.query.from}-to-${report.query.to}.csv`, () => vatReportToCsv(report)),
  ),
);

app.whenReady().then(() => {
  loadEnv();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
