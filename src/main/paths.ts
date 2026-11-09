import path from 'node:path';

/** Vendor and app folder names used under the platform's config and cache dirs. */
export const APP_DIR = path.join('vaslabs-ltd', 'stripe-analytics');

/**
 * Per-user cache dir for data the app can rebuild (the FX rate cache):
 *  - Linux:   $XDG_CACHE_HOME/vaslabs-ltd/stripe-analytics, else ~/.cache/…
 *  - Windows: %LOCALAPPDATA%\vaslabs-ltd\stripe-analytics\Cache (local, not roaming: caches
 *             shouldn't follow the user around the network)
 *  - macOS:   ~/Library/Caches/vaslabs-ltd/stripe-analytics
 */
export function cacheDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const app = p.join('vaslabs-ltd', 'stripe-analytics');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), app, 'Cache');
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', app);
  // XDG says a relative $XDG_CACHE_HOME is invalid and must be ignored.
  const xdg = env.XDG_CACHE_HOME && p.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : p.join(home, '.cache');
  return p.join(xdg, app);
}
