import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type Stripe from 'stripe';
import type { IpcResult, KeyStatus, ReportView, RevenueQuery, RevenueReport, VatQuery, VatReport } from '../shared/types';
import {
  checkKeyAccess,
  createStripeClient,
  isRestrictedKey,
  revenueByCountry,
  stripeInvoiceSource,
  stripeServiceSource,
  vatReport,
  type InvoiceSource,
  type ServiceSource,
} from './stripe';
import { demoInvoiceSource, demoServiceSource, isDemoKey } from './demo';
import { vatReportToCsv } from './vat';
import { reportToCsv } from './analytics';
import { FxRateStore } from './fx';
import { APP_DIR, cacheDir } from './paths';
import { loadSettings, saveSettings } from './settings';

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
function loadEnv(): void {
  const candidates = [path.join(process.cwd(), '.env'), configEnvFile(), path.join(app.getPath('userData'), '.env')];
  const found = candidates.find((p) => existsSync(p));
  if (found) dotenv.config({ path: found, quiet: true });
  // Demo mode only starts from the key dialog, never from a saved or exported key.
  if (isDemoKey(process.env.STRIPE_PASSKEY)) delete process.env.STRIPE_PASSKEY;
}

/** Save the key to the config dir's .env (owner-only permissions), keeping any other lines. */
async function saveKey(key: string): Promise<string> {
  const file = configEnvFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? (await readFile(file, 'utf8')).split(/\r?\n/) : [];
  const kept = existing.filter((l) => l.trim() && !/^\s*(export\s+)?STRIPE_PASSKEY\s*=/.test(l));
  await writeFile(file, [...kept, `STRIPE_PASSKEY=${key}`].join('\n') + '\n', { mode: 0o600 });
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

ipcMain.handle('key-status', (): KeyStatus => {
  const key = process.env.STRIPE_PASSKEY;
  const state = demo ? 'demo' : !key ? 'missing' : isRestrictedKey(key) ? 'ok' : 'invalid';
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
    const file = await saveKey(key);
    process.env.STRIPE_PASSKEY = key;
    stripe = client;
    demo = false;
    return file;
  });
  if (res.ok) reloadSoon(event.sender);
  return res;
});

ipcMain.handle('revenue-by-country', (event, query: RevenueQuery) =>
  wrap(() => revenueByCountry(getInvoices(), getFxStore(), query ?? {}, (p) => event.sender.send('progress', p), getServices())),
);

async function saveCsv(sender: Electron.WebContents, title: string, defaultPath: string, csv: () => string): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const opts = { title, defaultPath, filters: [{ name: 'CSV', extensions: ['csv'] }] };
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, csv(), 'utf8');
  return res.filePath;
}

ipcMain.handle('export-csv', (event, report: RevenueReport, view: ReportView) =>
  wrap(() =>
    saveCsv(
      event.sender,
      view.startsWith('service') ? 'Export revenue by service' : 'Export revenue by country',
      `${demo ? 'demo-' : ''}${view.startsWith('service') ? 'revenue-by-service' : 'revenue-by-country'}${view.endsWith('eur') ? '-eur' : ''}-${new Date().toISOString().slice(0, 10)}.csv`,
      () => reportToCsv(report, view),
    ),
  ),
);

ipcMain.handle('vat-report', (event, query: VatQuery) =>
  wrap(async () => {
    const { vatFetch } = await loadSettings(settingsFile());
    return vatReport(getInvoices(), getFxStore(), query, (p) => event.sender.send('progress', p), vatFetch);
  }),
);

ipcMain.handle('get-settings', () => wrap(async () => ({ settings: await loadSettings(settingsFile()), file: settingsFile() })));
ipcMain.handle('save-settings', (_event, raw: unknown) => wrap(() => saveSettings(settingsFile(), raw)));

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
