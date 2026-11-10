# Stripe Analytics

A desktop app (Electron + TypeScript) for Linux and Windows that builds regulatory reports from
your Stripe invoices, using a read-only key.

## What it's for

[Vaslabs](https://vaslabs.io), a company registered in Cyprus that bills its customers through
Stripe, built this for two recurring filings:

1. **Central Bank statistics.** Each calendar quarter, the Central Bank of Cyprus collects the
   Services Survey (QSRVS) through its EDX e-business platform. The **Country Revenue** tab gives
   the revenue side of it, paid invoice totals per customer country and currency for the
   quarter, with a EUR view and a currency mix.
2. **VAT and VIES returns.** The **Cyprus VAT** tab splits a VAT quarter's invoices into domestic
   (output VAT owed), EU B2B (the monthly VIES listing, per customer VAT number) and
   international, and flags invoices whose tax treatment looks wrong. Cyprus VAT quarters have
   traditionally been staggered (Mar–May, Jun–Aug, Sep–Nov, Dec–Feb) and are moving to calendar
   quarters, so the tab supports both.

It's published as-is in case it helps someone with the same setup. It assumes a Cyprus VAT
registration and supports only EUR, GBP and USD invoices; other setups will need changes.
It isn't tax or accounting advice: check the figures before you file them.
This project isn't affiliated with or endorsed by Stripe.

## Reports

The app has one tab per report.

### Country Revenue (Central Bank Services Survey, QSRVS)
Sum of `amount_paid` across invoices with status `paid`, grouped by **customer country** and **invoice currency**.
Currencies are never converted or mixed.

The country comes from the first one of these that is set:
1. the customer's billing address (`customer.address.country`)
2. the address snapshot stored on the invoice (`invoice.customer_address.country`)
3. the customer's shipping address
4. otherwise `??` (Unknown)

The footer shows how many invoices used each source. You can filter by date range (invoice `created`, UTC) and currency, sort by any column, and export to CSV.
The Quarter/Year pickers fill in the date range for a calendar quarter; only quarters that have fully ended can be picked.

Not counted: refunds, credit notes, and invoices that are only partly paid (`open`).
Reports cover complete past days only (UTC): they always end at yesterday at the latest.

Only **EUR, GBP and USD** are supported; an invoice in any other currency stops the report with an error.

### EUR view
The **EUR view** button switches the table to one row per country, with every currency converted
to EUR and summed (≈ EUR, % of total, invoices, distinct customers, currencies paid in).
Export CSV exports whichever view is showing. The currency filter doesn't apply in this view.

### Currency mix
To compare currencies, each invoice is converted to **EUR** at the ECB reference rate on its
payment date (`status_transitions.paid_at`). The app shows each currency's share of total revenue
and an "≈ EUR" column. Weekends and holidays use the previous ECB publication day's rate.

Rates are cached in [`data/fx-rates.csv`](data/fx-rates.csv), which is committed:

```
date,base,currency,rate,ecb_date
2026-10-04,eur,usd,1.13,2026-10-02
```

One row per calendar day and currency; `rate` is units of `currency` per 1 EUR, and `ecb_date` is
the publication day the rate came from. Only dates missing from the file are requested from
`api.frankfurter.dev` (one request covering the gap), then added to the file. Only currency
codes and dates are sent to it, never Stripe data. Commit the file after runs that add rates.
In the packaged app, the file is a cache copied on first use to:

- Linux: `~/.cache/vaslabs-ltd/stripe-analytics/fx-rates.csv` (`$XDG_CACHE_HOME` is respected)
- Windows: `%LOCALAPPDATA%\vaslabs-ltd\stripe-analytics\Cache\fx-rates.csv`

It's seeded from the old location (`~/.config/Stripe Analytics/fx-rates.csv`) if that exists, else
from the bundled file. Deleting it is safe: missing rates are fetched again. Set `FX_RATES_FILE`
to use a different path.

### Cyprus VAT
Finalized invoices (`paid`, `open`, `uncollectible`; never `draft` or `void`) whose **invoice date**
(`effective_at`, else the finalization date) falls in the chosen VAT quarter, split into:

- **Cyprus VAT**: customers in Cyprus. Net, VAT and gross per invoice; the summary shows the
  output VAT owed for the quarter and how much of it has been collected (invoice paid).
- **VIES**: customers in other EU countries (B2B, reverse charge). Shown **per month**, with one
  line per customer VAT number, which is what the monthly VIES return asks for, plus the invoices behind it.
- **International**: everyone else (B2B, outside the scope of Cyprus VAT).

**VAT quarters.** Cyprus VAT periods have traditionally been staggered quarters starting in March:
Mar–May, Jun–Aug, Sep–Nov and Dec–Feb (which spans two calendar years). Cyprus is moving VAT
returns to calendar quarters (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec). The quarter picker defaults to
the legacy scheme, and a scheme selector switches to calendar quarters. Pick whichever scheme your
VAT return is on for the period you're filing; for the return that covers the switch, check the
period dates the Tax Department gives you. The current quarter can be loaded too ("to date").
Amounts are converted to EUR at the ECB rate on the invoice date (same rate cache as above),
rounded per invoice. The country is the one on the invoice's address snapshot first, then the
customer's address; the VAT number is the one snapshotted on the invoice.

Each invoice shows its tax treatment from Stripe Tax (`taxability_reason`: standard rate, exempt
product, 0% rate, reverse charge, …), and the Cyprus summary shows how much of the net is 0%/exempt
(e.g. B2C tutoring). Rows are flagged for review when: a Cyprus invoice has no VAT *and* Stripe
recorded no exemption or 0% rate for it, an EU invoice has VAT or no
VAT number, an international invoice has VAT, or the country is unknown.
Not included: credit notes/refunds and input VAT. Invoices are listed by creation date going
back 365 days before the quarter, to catch invoices finalized or back-dated into it.
Export CSV writes one row per invoice.

## Stripe key (read-only)

Create a **restricted key** in the Stripe Dashboard → Developers → API keys, with **Read** access to:
- Invoices
- Customers

The app won't start a query with a standard `sk_` secret key; it accepts only `rk_` restricted keys.

**On first start, the app asks for the key** if it can't find one (or finds a non-restricted
one). It checks the key with one read call each to Invoices and Customers, then saves it to:

- Linux: `~/.config/vaslabs-ltd/stripe-analytics/.env` (`$XDG_CONFIG_HOME` is respected)
- Windows: `%APPDATA%\vaslabs-ltd\stripe-analytics\.env`

as `STRIPE_PASSKEY=rk_...`, readable only by you (mode 600 on Linux). The **Stripe key…** button
replaces it. You can also write that file yourself.

The key is read from the first of these that exists: `.env` in the current directory (handy for
`npm start`), the file above, then the old location (`~/.config/Stripe Analytics/.env`).
A `STRIPE_PASSKEY` environment variable wins over all of them. After you type it in, the key
stays in the Electron main process and is never sent back to the UI.

## Development

```sh
npm install
npm start        # build and launch
npm test         # unit tests for the aggregation
npm run typecheck
```

## Download

Get the latest build from the GitHub **Releases** page:

- Linux: `stripe-analytics-<version>-x86_64.AppImage`
- Windows: `stripe-analytics-<version>-setup-x64.exe`

Each file has a `.sha256` checksum next to it.

To run it on Linux:

```sh
chmod +x stripe-analytics-0.2.0-x86_64.AppImage
./stripe-analytics-0.2.0-x86_64.AppImage   # asks for the Stripe key on first start
```

AppImages need FUSE (`sudo dnf install fuse-libs` on Fedora, `sudo apt install libfuse2` on Debian/Ubuntu).

On Windows, run `stripe-analytics-0.2.0-setup-x64.exe`. It installs for the current user (no admin
rights) and adds a Start-menu entry. The installer isn't code-signed, so SmartScreen asks first:
**More info → Run anyway**.

## Releases (CI)

CI never needs the Stripe key.

### GitHub Actions

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the typecheck and tests, then builds
the AppImage (Ubuntu runner) and the Windows installer (Windows runner). On pull requests the
files are kept as run artifacts for 30 days.

**Every push to `master` is released automatically.** The workflow tags the commit with the next
version and creates a GitHub Release with both files and their checksums. The version
([`scripts/next-version.mjs`](scripts/next-version.mjs)) is the next patch after the newest
`vX.Y.Z` tag. For a minor or major release, set a higher `version` in `package.json` and push;
that version is used as-is.

### GitLab CI

[`.gitlab-ci.yml`](.gitlab-ci.yml) builds the same two files on every pipeline (job artifacts,
kept for 30 days). Tags like `v0.2.0` also upload them to the project's package registry and
create a GitLab Release:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The `windows` job cross-compiles on a Linux runner (`node:22-bookworm`). electron-builder runs the
Windows resource tools through Wine, and the NSIS installer runs a 32-bit stub to build its
uninstaller, so the job installs Debian's `wine`, `wine64` and `wine32:i386`.

## Packaging locally

```sh
sudo dnf install rpm-build   # needed for the rpm target
npm run dist                 # writes an AppImage and an .rpm to release/
npm run dist:appimage        # AppImage only (what CI builds)
sudo dnf install wine        # needed for the Windows build
npm run dist:win             # Windows installer: release/stripe-analytics-<version>-setup-x64.exe
```

## Layout

```
src/main/      Electron main process: Stripe client, aggregation, IPC
src/preload/   contextBridge API exposed to the UI
src/renderer/  UI (sandboxed, no Node access)
src/shared/    types shared by main and renderer
```

## License

[MIT](LICENSE) © Vaslabs Ltd
