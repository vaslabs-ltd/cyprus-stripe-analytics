import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Progress, StripeAnalyticsApi } from '../shared/types';

const api: StripeAnalyticsApi = {
  keyStatus: () => ipcRenderer.invoke('key-status'),
  saveKey: (key) => ipcRenderer.invoke('save-key', key),
  revenueByCountry: (query) => ipcRenderer.invoke('revenue-by-country', query),
  exportCsv: (report, view, breakdown) => ipcRenderer.invoke('export-csv', report, view, breakdown),
  vatReport: (query) => ipcRenderer.invoke('vat-report', query),
  exportVatCsv: (report) => ipcRenderer.invoke('export-vat-csv', report),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  listProducts: () => ipcRenderer.invoke('list-products'),
  sessionStatus: () => ipcRenderer.invoke('session-status'),
  unlockSession: (pin) => ipcRenderer.invoke('unlock-session', pin),
  restoreSession: () => ipcRenderer.invoke('restore-session'),
  saveSession: (session) => ipcRenderer.invoke('save-session', session),
  setPin: (opts) => ipcRenderer.invoke('set-pin', opts),
  removePin: (currentPin) => ipcRenderer.invoke('remove-pin', currentPin),
  resetPin: () => ipcRenderer.invoke('reset-pin'),
  lockNow: () => ipcRenderer.invoke('lock-now'),
  regroupContractors: (report) => ipcRenderer.invoke('regroup-contractors', report),
  onProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: Progress) => cb(p);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
};

contextBridge.exposeInMainWorld('stripeAnalytics', api);
