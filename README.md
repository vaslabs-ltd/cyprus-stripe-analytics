# Stripe Analytics

A desktop app (Electron + TypeScript) for Linux/Fedora that pulls analytics from your Stripe invoices.

## Reports

### Revenue by country
Sum of `amount_paid` across invoices with status `paid`, grouped by **customer country** and **invoice currency**.
Currencies are never converted or mixed.

The country comes from the first one of these that is set:
1. the customer's billing address (`customer.address.country`)
2. the address snapshot stored on the invoice (`invoice.customer_address.country`)
3. the customer's shipping address
4. otherwise `??` (Unknown)

The footer shows how many invoices used each source. You can filter by date range (invoice `created`, UTC) and currency, sort by any column, and export to CSV.

Not counted: refunds, credit notes, and invoices that are only partly paid (`open`).
Reports cover complete past days only (UTC): they always end at yesterday at the latest.

Only **EUR, GBP and USD** are supported; an invoice in any other currency stops the report with an error.

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
In the packaged app, the file is copied to `~/.config/Stripe Analytics/fx-rates.csv` on first use
(set `FX_RATES_FILE` to use a different path).

## Stripe key (read-only)

Create a **restricted key** in the Stripe Dashboard → Developers → API keys, with **Read** access to:
- Invoices
- Customers

The app won't start a query with a standard `sk_` secret key; it accepts only `rk_` restricted keys.

Put it in `.env` (which git ignores):

```
STRIPE_PASSKEY=rk_live_...
```

`.env` is read from the current directory first, then from `~/.config/stripe-analytics/.env` (`~/.config/Stripe Analytics/.env` for the packaged app). The key stays in the Electron main process and is never sent to the UI.

## Development

```sh
npm install
npm start        # build and launch
npm test         # unit tests for the aggregation
npm run typecheck
```

## Packaging for Fedora

```sh
sudo dnf install rpm-build   # needed for the rpm target
npm run dist                 # writes an AppImage and an .rpm to release/
```

## Layout

```
src/main/      Electron main process: Stripe client, aggregation, IPC
src/preload/   contextBridge API exposed to the UI
src/renderer/  UI (sandboxed, no Node access)
src/shared/    types shared by main and renderer
```
