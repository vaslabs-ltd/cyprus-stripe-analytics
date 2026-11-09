import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type Stripe from 'stripe';
import type { IpcResult, ReportView, RevenueQuery, RevenueReport, VatQuery, VatReport } from '../shared/types';
import { createStripeClient, revenueByCountry, vatReport } from './stripe';
import { vatReportToCsv } from './vat';
import { reportToCsv } from './analytics';
import { FxRateStore } from './fx';

/**
 * Load .env from the first location that exists:
 *  1. the current working directory (dev: `npm start`)
 *  2. the user config dir, e.g. ~/.config/stripe-analytics/.env (installed app)
 */
function loadEnv(): void {
  const candidates = [path.join(process.cwd(), '.env'), path.join(app.getPath('userData'), '.env')];
  const found = candidates.find((p) => existsSync(p));
  if (found) dotenv.config({ path: found, quiet: true });
}

let stripe: Stripe | null = null;
function getStripe(): Stripe {
  stripe ??= createStripeClient(process.env.STRIPE_PASSKEY);
  return stripe;
}

let fxStore: FxRateStore | null = null;
/**
 * Dev: the committed data/fx-rates.csv in the project. Packaged app: a copy in the user
 * config dir (the app bundle is read-only), seeded from the bundled file on first use.
 */
function getFxStore(): FxRateStore {
  if (fxStore) return fxStore;
  const bundled = path.join(app.getAppPath(), 'data', 'fx-rates.csv');
  let file = process.env.FX_RATES_FILE || bundled;
  if (!process.env.FX_RATES_FILE && app.isPackaged) {
    file = path.join(app.getPath('userData'), 'fx-rates.csv');
    if (!existsSync(file) && existsSync(bundled)) copyFileSync(bundled, file);
  }
  fxStore = new FxRateStore(file);
  return fxStore;
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

ipcMain.handle('revenue-by-country', (event, query: RevenueQuery) =>
  wrap(() => revenueByCountry(getStripe(), getFxStore(), query ?? {}, (p) => event.sender.send('progress', p))),
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
      'Export revenue by country',
      `revenue-by-country${view === 'eur' ? '-eur' : ''}-${new Date().toISOString().slice(0, 10)}.csv`,
      () => reportToCsv(report, view),
    ),
  ),
);

ipcMain.handle('vat-report', (event, query: VatQuery) =>
  wrap(() => vatReport(getStripe(), getFxStore(), query, (p) => event.sender.send('progress', p))),
);

ipcMain.handle('export-vat-csv', (event, report: VatReport) =>
  wrap(() =>
    saveCsv(event.sender, 'Export Cyprus VAT report', `cyprus-vat-${report.query.from}-to-${report.query.to}.csv`, () => vatReportToCsv(report)),
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
