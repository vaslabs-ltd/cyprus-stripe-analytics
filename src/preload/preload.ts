import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Progress, StripeAnalyticsApi } from '../shared/types';

const api: StripeAnalyticsApi = {
  revenueByCountry: (query) => ipcRenderer.invoke('revenue-by-country', query),
  exportCsv: (report, view) => ipcRenderer.invoke('export-csv', report, view),
  vatReport: (query) => ipcRenderer.invoke('vat-report', query),
  exportVatCsv: (report) => ipcRenderer.invoke('export-vat-csv', report),
  onProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: Progress) => cb(p);
    ipcRenderer.on('progress', listener);
    return () => ipcRenderer.removeListener('progress', listener);
  },
};

contextBridge.exposeInMainWorld('stripeAnalytics', api);
