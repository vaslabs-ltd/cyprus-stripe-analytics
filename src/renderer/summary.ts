import type { CompanyDetails, RevenueReport, StripeAnalyticsApi, SummaryFiles, SummarySection } from '../shared/types';
import { $, plural, setStatus as setStatusOn } from './ui.js';

const COMPANY_FIELDS: Array<keyof CompanyDetails> = ['name', 'address', 'country', 'registration', 'email', 'website'];

/**
 * Executive summary tab: pick the sections, check the company details, and export a reveal.js
 * presentation and a written summary of the report shown in the Revenue tab.
 */
export function initSummaryTab(api: StripeAnalyticsApi, getReport: () => RevenueReport | null): { refresh(): void; shown(): void } {
  const form = $<HTMLFormElement>('#summary-form');
  const sourceEl = $<HTMLElement>('#summary-source');
  const titleInput = $<HTMLInputElement>('#summary-title');
  const sectionBoxes = [...document.querySelectorAll<HTMLInputElement>('#summary-sections input[type="checkbox"]')];
  const companySet = $<HTMLFieldSetElement>('#summary-company');
  const field = (k: keyof CompanyDetails) => companySet.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${k}"]`)!;
  const stripeBtn = $<HTMLButtonElement>('#company-stripe');
  const exportBtn = $<HTMLButtonElement>('#summary-export');
  const openPresentation = $<HTMLButtonElement>('#summary-open-presentation');
  const openSummary = $<HTMLButtonElement>('#summary-open-summary');
  const statusEl = $<HTMLElement>('#summary-status');
  const companyStatusEl = $<HTMLElement>('#company-status');
  const companyHint = $<HTMLElement>('#company-hint');
  const setStatus = (text: string, error = false) => setStatusOn(statusEl, text, error);
  const setCompanyStatus = (text: string, error = false) => setStatusOn(companyStatusEl, text, error);

  let files: SummaryFiles | null = null;

  const readCompany = (): CompanyDetails => Object.fromEntries(COMPANY_FIELDS.map((k) => [k, field(k).value])) as unknown as CompanyDetails;
  const showCompany = (c: CompanyDetails) => COMPANY_FIELDS.forEach((k) => (field(k).value = c[k]));

  /** Whether there are company details yet: until there are, they're read from Stripe once. */
  let saved = false;
  /** Encrypted with the PIN, which hasn't been entered: nothing to show, nothing to change. */
  let locked = false;
  /** Read automatically at most once per run, so a key without access isn't asked again and again. */
  let triedStripe = false;

  /** The details from the vault, and where they're kept. */
  async function load(): Promise<void> {
    const res = await api.getCompany();
    if (!res.ok) return setCompanyStatus(res.error, true);
    const { company, kept } = res.value;
    ({ saved, locked } = res.value);
    showCompany(company);
    companySet.disabled = locked;
    companyHint.textContent = locked
      ? 'Encrypted with your PIN: unlock in Options → Last session to see and edit them.'
      : kept
        ? "Saved encrypted with your PIN, like the last session. Read from Stripe the first time; after that your edits are kept and Stripe isn't asked again unless you reset them."
        : 'Without a PIN nothing is saved: these are kept only until the app closes. Set a PIN in Options → Last session to keep them, encrypted.';
  }
  const loaded = load();

  async function saveCompany(): Promise<void> {
    const res = await api.saveCompany(readCompany());
    if (!res.ok) return setCompanyStatus(res.error, true);
    saved = true;
  }
  companySet.addEventListener('change', () => void saveCompany());

  /**
   * Reads the account and fills the form with it. Fields the account has no value for keep what's
   * there (e.g. a registration number typed in).
   */
  async function fromStripe(): Promise<void> {
    stripeBtn.disabled = true;
    setCompanyStatus('Reading the account from Stripe…');
    const res = await api.companyFromStripe();
    stripeBtn.disabled = false;
    if (!res.ok) return setCompanyStatus(res.error, true);
    const current = readCompany();
    showCompany(Object.fromEntries(COMPANY_FIELDS.map((k) => [k, res.value[k] || current[k]])) as unknown as CompanyDetails);
    await saveCompany();
    const missing = COMPANY_FIELDS.filter((k) => !res.value[k]).length;
    setCompanyStatus(missing ? `Read from Stripe and saved; ${plural(missing, 'field')} not in the account, to type in.` : 'Read from Stripe and saved.');
  }

  /** First time the tab is shown with nothing saved yet: read the account once. */
  async function shown(): Promise<void> {
    refresh();
    await loaded;
    // Every time: the PIN may have been entered, set or removed since.
    await load();
    if (saved || locked || triedStripe) return;
    triedStripe = true;
    await fromStripe();
  }

  stripeBtn.addEventListener('click', () => {
    const ok = window.confirm(
      'Read the company details from the Stripe account again?\n\nEvery field Stripe has a value for replaces your edit; fields Stripe leaves empty keep what you typed.',
    );
    if (ok) void fromStripe();
  });

  function refresh(): void {
    const r = getReport();
    exportBtn.disabled = !r;
    sourceEl.classList.toggle('error', !r);
    if (!r) {
      sourceEl.textContent = 'Load a report in the Revenue tab first: the summary covers its period.';
      return;
    }
    const { from, to } = r.query;
    const period = from || to ? `${from || 'the start'} to ${to || 'today'}` : 'all time';
    const invoices = r.totalsByCurrency.reduce((n, t) => n + t.invoiceCount, 0);
    sourceEl.textContent = `Reporting ${period}, ${r.vat === 'excluded' ? 'excluding' : 'including'} VAT (as in the Revenue tab): ${plural(invoices, 'paid invoice')}.`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const report = getReport();
    if (!report) return refresh();
    const sections = sectionBoxes.filter((b) => b.checked).map((b) => b.value as SummarySection);
    if (!sections.length) return setStatus('Choose at least one section.', true);
    exportBtn.disabled = true;
    setStatus('Creating…');
    const res = await api.exportSummary({ report, sections, company: readCompany(), title: titleInput.value });
    exportBtn.disabled = false;
    if (!res.ok) return setStatus(res.error, true);
    if (!res.value) return setStatus('');
    files = res.value;
    openPresentation.hidden = openSummary.hidden = false;
    setStatus(`Saved ${files.presentation} and ${files.summary}`);
  });

  const open = async (file: string | undefined) => {
    if (!file) return;
    const res = await api.openExported(file);
    if (!res.ok) setStatus(res.error, true);
  };
  openPresentation.addEventListener('click', () => void open(files?.presentation));
  openSummary.addEventListener('click', () => void open(files?.summary));

  refresh();
  return { refresh, shown: () => void shown() };
}
