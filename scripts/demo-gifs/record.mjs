// Records the README's demo GIFs from the real app, in demo mode.
//
//   npm run gifs                  # all scenes
//   npm run gifs -- vat vies      # only some (see SCENES below)
//
// Needs ffmpeg on PATH and a display (on a headless Linux box: `xvfb-run npm run gifs`).
//
// How it works: Playwright drives the built Electron app. Captions, the spotlight and the pointer
// are elements injected into the page, so they're part of the screenshot. Each step takes one
// screenshot and holds it for a set time; ffmpeg turns the frames into a GIF with an optimised
// palette. The app runs with temporary config and cache folders and no STRIPE_PASSKEY, so a real
// key or real data can never end up in a recording.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'gifs');
const SIZE = { width: 1280, height: 760 };
const GIF_WIDTH = 1000;

// ---------- app ----------

async function launchApp() {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'stripe-analytics-gifs-'));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(sandbox, 'config'), XDG_CACHE_HOME: path.join(sandbox, 'cache') };
  delete env.STRIPE_PASSKEY;
  delete env.FX_RATES_FILE;
  // cwd = the sandbox, so the project's own .env (read from the current directory) isn't loaded.
  const app = await electron.launch({ args: [ROOT], cwd: sandbox, env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }, size) => {
    nativeTheme.themeSource = 'light';
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
  }, SIZE);
  // The native save dialog isn't part of the page: answer it with the default file name. A bare
  // name is written to the app's working directory (the sandbox), and the status line shows just
  // the name rather than a temp path with the local user name in it.
  await app.evaluate(({ dialog }) => {
    // Called as showSaveDialog(win, opts) or showSaveDialog(opts).
    dialog.showSaveDialog = async (a, b) => ({ canceled: false, filePath: (b ?? a).defaultPath });
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page, sandbox };
}

// ---------- overlays (styled through CSSOM: the page's CSP blocks <style> tags) ----------

const OVERLAY_JS = () => {
  if (window.__demo) return;
  const make = (css) => {
    const e = document.createElement('div');
    Object.assign(e.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483000' }, css);
    // A modal dialog sits in the top layer, above any z-index: put the overlays inside it.
    (document.querySelector('dialog[open]') ?? document.body).append(e);
    return e;
  };
  const spot = make({ display: 'none', borderRadius: '8px', border: '3px solid #f5a623', boxShadow: '0 0 0 9999px rgba(20,20,30,0.38)' });
  const caption = make({
    display: 'none', left: '50%', bottom: '22px', transform: 'translateX(-50%)', maxWidth: '86%',
    background: 'rgba(20,20,30,0.92)', color: '#fff', padding: '12px 20px', borderRadius: '10px',
    font: '600 17px/1.35 system-ui, sans-serif', textAlign: 'center', boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
  });
  const pointer = make({
    width: '22px', height: '22px', borderRadius: '50%', left: '-50px', top: '-50px',
    background: 'rgba(245,166,35,0.45)', border: '2px solid #f5a623', transform: 'translate(-50%,-50%)',
  });
  window.__demo = {
    caption(text, sub) {
      caption.replaceChildren(document.createTextNode(text));
      if (sub) {
        const s = document.createElement('div');
        Object.assign(s.style, { font: '400 14px/1.35 system-ui, sans-serif', opacity: '0.85', marginTop: '4px' });
        s.textContent = sub;
        caption.append(s);
      }
      caption.style.display = text ? 'block' : 'none';
    },
    spot(sel, pad = 6) {
      const t = sel && document.querySelector(sel);
      if (!t) return void (spot.style.display = 'none');
      const r = t.getBoundingClientRect();
      Object.assign(spot.style, { display: 'block', left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    },
    pointer(x, y, pressed) {
      Object.assign(pointer.style, { left: `${x}px`, top: `${y}px`, width: pressed ? '30px' : '22px', height: pressed ? '30px' : '22px' });
    },
  };
};

// ---------- recording ----------

class Recorder {
  constructor(page, name) {
    this.page = page;
    this.name = name;
    this.dir = mkdtempSync(path.join(tmpdir(), `gif-${name}-`));
    this.frames = [];
    this.pos = { x: SIZE.width / 2, y: SIZE.height + 40 };
  }
  async overlay() {
    await this.page.evaluate(OVERLAY_JS);
  }
  async snap(ms) {
    const file = path.join(this.dir, `${String(this.frames.length).padStart(4, '0')}.png`);
    await this.page.screenshot({ path: file });
    this.frames.push({ file, ms });
  }
  async caption(text, sub, ms = 0) {
    await this.page.evaluate(([t, s]) => window.__demo.caption(t, s), [text, sub]);
    if (ms) await this.snap(ms);
  }
  async spot(sel, ms = 0, pad) {
    if (sel) await this.page.locator(sel).first().scrollIntoViewIfNeeded();
    await this.page.evaluate(([s, p]) => window.__demo.spot(s, p), [sel, pad]);
    if (ms) await this.snap(ms);
  }
  /** Glide the pointer to the centre of `sel`, a frame every ~40 ms. */
  async moveTo(sel) {
    const loc = this.page.locator(sel).first();
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = 1 - (1 - i / steps) ** 3; // ease out
      const x = this.pos.x + (to.x - this.pos.x) * t;
      const y = this.pos.y + (to.y - this.pos.y) * t;
      await this.page.evaluate(([x, y]) => window.__demo.pointer(x, y, false), [x, y]);
      await this.snap(40);
    }
    this.pos = to;
  }
  async press(ms = 160) {
    await this.page.evaluate(([x, y]) => window.__demo.pointer(x, y, true), [this.pos.x, this.pos.y]);
    await this.snap(ms);
    await this.page.evaluate(([x, y]) => window.__demo.pointer(x, y, false), [this.pos.x, this.pos.y]);
  }
  async click(sel) {
    await this.moveTo(sel);
    await this.press();
    await this.page.locator(sel).first().click();
  }
  async select(sel, value) {
    await this.moveTo(sel);
    await this.press();
    await this.page.locator(sel).first().selectOption(value);
  }
  async type(sel, text) {
    await this.moveTo(sel);
    await this.press();
    await this.page.locator(sel).first().focus();
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.snap(90);
    }
  }
  async scrollTo(sel) {
    const target = await this.page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top + window.scrollY - 80);
    const start = await this.page.evaluate(() => window.scrollY);
    for (let i = 1; i <= 10; i++) {
      const t = 1 - (1 - i / 10) ** 2;
      await this.page.evaluate((y) => window.scrollTo(0, y), start + (target - start) * t);
      await this.snap(40);
    }
  }
  async gif() {
    const list = this.frames.map((f) => `file '${f.file}'\nduration ${(f.ms / 1000).toFixed(3)}`).join('\n');
    // The concat demuxer ignores the last frame's duration unless the frame is listed again.
    writeFileSync(path.join(this.dir, 'frames.txt'), `${list}\nfile '${this.frames.at(-1).file}'\n`);
    mkdirSync(OUT, { recursive: true });
    const out = path.join(OUT, `${this.name}.gif`);
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(this.dir, 'frames.txt'),
      '-vf', `scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      '-fps_mode', 'vfr', '-loop', '0', out,
    ]);
    rmSync(this.dir, { recursive: true, force: true });
    const seconds = this.frames.reduce((s, f) => s + f.ms, 0) / 1000;
    console.log(`${path.relative(ROOT, out)}: ${this.frames.length} frames, ${seconds.toFixed(1)} s`);
  }
}

/** Wait until the status line says Loaded/Exported, or fail with what it says instead. */
async function status(page, sel) {
  const h = await page.waitForFunction((s) => {
    const t = document.querySelector(s)?.textContent ?? '';
    return (/^(Loaded|Exported)/.test(t) || document.querySelector(s)?.classList.contains('error')) && t;
  }, sel, { timeout: 60_000 });
  const text = await h.jsonValue();
  if (!/^(Loaded|Exported)/.test(text)) throw new Error(`${sel}: ${text}`);
}

/** Back to a clean page, still in demo mode. */
async function fresh(page) {
  await page.reload();
  await page.waitForSelector('#demo-banner:not([hidden])');
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ---------- scenes: one GIF each ----------

const SCENES = {
  async 'demo-key'(page) {
    const r = new Recorder(page, 'demo-key');
    await page.waitForSelector('#key-dialog[open]');
    // The dialog names the .env file a key would be saved to: here a sandbox path with the local
    // user name in it. Show the standard location instead (never written to: rk_demo isn't saved).
    await page.evaluate(() => (document.querySelector('#key-file').textContent = '~/.config/vaslabs-ltd/stripe-analytics/.env'));
    await r.overlay();
    await r.caption('On first start, the app asks for a restricted, read-only Stripe key', 'It refuses sk_ secret keys: reports only ever read invoices and customers', 2600);
    await r.caption('Enter rk_demo to try it with generated data', 'Nothing is saved, and it never talks to Stripe');
    await r.type('#key-input', 'rk_demo');
    await r.snap(700);
    await r.click('#key-save');
    await page.waitForSelector('#demo-banner:not([hidden])');
    await r.overlay(); // the window reloaded
    await r.spot('#demo-banner', 0, 4);
    await r.caption('Demo mode is always labelled', 'Restart the app or enter a real key to leave it', 2800);
    await r.gif();
  },

  async 'country-revenue'(page) {
    await fresh(page);
    const r = new Recorder(page, 'country-revenue');
    await r.overlay();
    await r.caption('Central Bank Services Survey (QSRVS)', 'Paid invoices per customer country and currency, for a calendar quarter', 2400);
    await r.spot('#quarter', 0, 4);
    await r.caption('Pick a quarter: only quarters that have ended can be chosen');
    await r.select('#quarter', '3');
    await r.spot('#query', 1600, 4);
    await r.spot(null);
    await r.caption('');
    await r.click('#load');
    await status(page, '#status');
    await r.snap(500);
    await r.spot('#totals', 0, 4);
    await r.caption('Totals per currency, never mixed', 'The bar shows each currency’s share, converted to EUR at the ECB rate', 3000);
    await r.spot('#table', 0, 2);
    await r.caption('One row per country and currency', 'Sort by any column', 1400);
    await r.spot(null);
    await r.click('#table th[data-sort="customers"]');
    await r.snap(1400);
    await r.caption('Filter to a single currency');
    await r.select('#currency', 'gbp');
    await r.snap(1800);
    await r.select('#currency', '');
    await r.caption('');
    await r.snap(500);
    await r.gif();
  },

  async 'eur-view'(page) {
    await fresh(page);
    await page.selectOption('#quarter', '3');
    await page.click('#load');
    await status(page, '#status');
    const r = new Recorder(page, 'eur-view');
    await r.overlay();
    await r.caption('EUR view', 'One row per country, with every currency converted to EUR and summed');
    await r.click('#eur-view');
    await r.snap(600);
    await r.spot('#eur-table', 2800, 2);
    await r.spot('#meta', 0, 4);
    await r.caption('Where each country came from', 'Billing address, the invoice’s address snapshot, or shipping address', 2800);
    await r.spot(null);
    await r.caption('Export CSV writes whichever view is showing');
    await r.click('#export');
    await status(page, '#status');
    await r.spot('#status', 2400, 4);
    await r.gif();
  },

  async 'service-view'(page) {
    await fresh(page);
    await page.selectOption('#quarter', '3');
    await page.click('#load');
    await status(page, '#status');
    const r = new Recorder(page, 'service-view');
    await r.overlay();
    await r.caption('Service view', 'The survey asks for each type of service separately', 2200);
    await r.click('#service-view');
    await r.snap(600);
    await r.spot('#totals', 0, 4);
    await r.caption('Service mix', 'Each Stripe product’s share of revenue, in EUR', 2800);
    await r.spot('#service-table tr.service', 0, 2);
    await r.caption('One group per service, with its countries underneath', 'Invoices are split across their line items by net amount', 3000);
    await r.spot(null);
    await r.caption('');
    await r.scrollTo('#service-table tr.service ~ tr.service');
    await r.spot('#service-table tr.service ~ tr.service', 0, 2);
    await r.caption('The smaller services get their own totals too', undefined, 2600);
    await r.spot(null);
    await r.scrollTo('#service-table tfoot');
    await r.spot('#service-table tfoot', 0, 2);
    await r.caption('Services add up to the same total as the country views', undefined, 2400);
    await r.spot(null);
    await r.caption('Export CSV: one row per service and country');
    await r.click('#export');
    await status(page, '#status');
    await r.spot('#status', 2400, 4);
    await r.gif();
  },

  async vat(page) {
    await fresh(page);
    const r = new Recorder(page, 'vat');
    await r.overlay();
    await r.click('#tab-vat');
    await r.caption('Cyprus VAT return', 'Finalized invoices by invoice date, converted to EUR', 2000);
    await r.spot('#vat-scheme', 0, 4);
    await r.caption('Legacy Cyprus VAT quarters: Mar–May, Jun–Aug, Sep–Nov, Dec–Feb', 'Or switch to calendar quarters', 2200);
    await r.select('#vat-scheme', 'calendar');
    await r.spot('#vat-period', 1500, 4);
    await r.select('#vat-scheme', 'legacy');
    await r.spot(null);
    await r.caption('');
    await r.click('#vat-load');
    await status(page, '#vat-status');
    await r.snap(500);
    await r.spot('#vat-summary', 0, 4);
    await r.caption('Output VAT owed and how much is collected', 'Plus net sales per section and how much of Cyprus sales is 0% or exempt', 3200);
    await r.spot('#vat-cy', 0, 2);
    await r.caption('Cyprus invoices with their tax treatment from Stripe Tax', undefined, 2600);
    await r.gif();
  },

  async vies(page) {
    await fresh(page);
    await page.click('#tab-vat');
    await page.click('#vat-load');
    await status(page, '#vat-status');
    const r = new Recorder(page, 'vies');
    await r.overlay();
    await r.scrollTo('#vat-vies-months');
    await r.spot('#vat-vies-months', 0, 4);
    await r.caption('VIES: one listing per month', 'EU business customers, reverse charge', 2400);
    await r.spot('#vat-vies', 0, 2);
    await r.caption('A line per customer VAT number, with the invoices behind it', undefined, 2400);
    const flagged = (await page.locator('#vat-vies tr.flagged').count()) ? '#vat-vies tr.flagged' : '#vat-content tr.flagged';
    if (await page.locator(flagged).count()) {
      await r.spot(flagged, 0, 2);
      await r.caption('Rows that need a look are flagged', 'Missing VAT number, VAT on a reverse-charge invoice, unknown country…', 3000);
    }
    await r.spot(null);
    await r.scrollTo('#vat-intl');
    await r.spot('#vat-intl', 0, 2);
    await r.caption('International: customers outside the EU, outside the scope of Cyprus VAT', undefined, 2600);
    await r.gif();
  },

  // Last: it changes saved settings (reset at the end), which the VAT scenes must not see.
  async options(page) {
    await fresh(page);
    const r = new Recorder(page, 'options');
    // As in the demo-key scene: show the standard location, not the sandbox path with the user name.
    await page.evaluate(() => (document.querySelector('#options-file').textContent = '~/.config/vaslabs-ltd/stripe-analytics/settings.json'));
    await r.overlay();
    await r.caption('Options: which invoices the VAT report fetches', undefined, 1200);
    await r.click('#tab-options');
    await r.snap(600);
    await r.spot('#options-form fieldset', 0, 4);
    await r.caption('Stripe searches invoices by creation date, the VAT report goes by invoice date', 'A wider search also finds invoices finalized late or back-dated into the quarter', 3200);
    await r.spot(null);
    await r.caption('');
    await r.select('#opt-lookback', '92');
    await r.click('#opt-after');
    await r.spot('#options-status', 1800, 6);
    await r.spot('#opt-statuses', 0, 4);
    await r.caption('Invoice statuses to include', 'Draft and void are not VAT invoices: include them only to look for mistakes', 2400);
    await r.spot(null);
    await r.caption('');
    await r.click('#opt-statuses input[value="draft"]');
    await r.snap(1000);
    await r.caption('Saved straight away, used the next time a report loads', undefined, 1800);
    await r.caption('');
    await r.click('#tab-vat');
    await r.click('#vat-load');
    await status(page, '#vat-status');
    await r.snap(400);
    // The footer is the last thing on the page: room below it keeps the caption from covering it.
    await page.evaluate(() => (document.body.style.paddingBottom = '160px'));
    await r.scrollTo('#vat-meta');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await r.spot('#vat-meta', 0, 4);
    await r.caption('The report says what it searched', 'Created-date window and statuses', 3000);
    await r.spot(null);
    await r.caption('');
    await page.evaluate(() => (document.body.style.paddingBottom = ''));
    await r.click('#tab-options');
    await r.caption('Reset to defaults: fastest search, finalized invoices only');
    await r.click('#opt-defaults');
    await r.snap(2200);
    await r.gif();
  },
};

// ---------- main ----------

const wanted = process.argv.slice(2);
for (const w of wanted) if (!(w in SCENES)) throw new Error(`Unknown scene "${w}". Scenes: ${Object.keys(SCENES).join(', ')}`);

const { app, page, sandbox } = await launchApp();
try {
  // The first scene enters the demo key; the others need demo mode, so enter it off camera if skipped.
  for (const [name, scene] of Object.entries(SCENES)) {
    if (wanted.length && !wanted.includes(name)) {
      if (name === 'demo-key') {
        await page.waitForSelector('#key-dialog[open]');
        await page.fill('#key-input', 'rk_demo');
        await page.click('#key-save');
        await page.waitForSelector('#demo-banner:not([hidden])');
      }
      continue;
    }
    await scene(page);
  }
} finally {
  await app.close();
  rmSync(sandbox, { recursive: true, force: true });
}
