# Payments ledger

Payment reporting an accountant can actually use, opened from a menu item inside a HighLevel sub-account.

## Why I built it

A business I work with runs several companies through one Stripe account. Rent from a few properties, coaching, services. The bank statement only shows "Stripe transfer" with a total. Nobody could say which payments made up a deposit, or which business each payment belonged to. Cheques and cash were recorded by hand in the CRM and never showed up next to the Stripe money at all.

So every month the accountant asked the same questions, and someone spent hours answering them from three screens.

I built this so the answer is one page.

## What it does

- Pulls Stripe balance transactions and payouts, plus the CRM's payment records and contacts.
- Joins them. A Stripe payment and its CRM twin become one line, with the payer, the invoice title, the fee and the net.
- Tags every payment to a business, and for rent to the property and suite, using rules you set per location.
- Breaks every bank deposit into the payments inside it, so each Stripe transfer on the statement can be labelled.
- Flags what it cannot place instead of guessing: rent with no address on record, a payment that may be between your own companies, a loan repayment that is not income.
- Monthly close: check a month, lock it, and download three files. A summary per business, every payment, and a QuickBooks Online journal import. A locked month never changes, even if rules or data change later.
- Accountant sign-in by email link, for people who never open the CRM. A link works once, for 30 minutes.
- Records who opened the reports and when.

## How it works

| Piece | Where |
|---|---|
| The page, opened from a custom menu link in the sub-account | `src/page.html` |
| Sign-in: the HighLevel SSO payload is decrypted on the server, then checked against a viewer list | `src/crypto.ts`, `src/index.ts` |
| Email link sign-in, only a hash of each link is stored | `src/signin.ts` |
| Sync every 15 minutes: Stripe balance transactions and payout links, CRM payments and contacts | `src/sync.ts` |
| Rules: business, space, income type, review flags | `src/classify.ts` |
| Monthly close and the QuickBooks journal file | `src/close.ts` |
| Admin routes: config, Stripe key, sync, status, exports | `/admin/*` in `src/index.ts` |

Nothing tenant-specific lives in code. Business names, property and suite rules, viewers, timezone and QuickBooks account names are one JSON config per location, stored in D1. See `config.example.json`.

One deploy serves any number of sub-accounts. Every table is keyed by location id. It handles single location installs and agency level installs, where it mints a token per sub-account.

Stripe access is a restricted read-only key. The app never writes to Stripe. OAuth tokens and the Stripe key are encrypted at rest with AES-GCM. The admin secret never lives on the server, only its SHA-256 does.

Each scheduled run does a bounded slice of work so it fits the Cloudflare free plan. A backfill catches up over a few runs.

## Stack

- Cloudflare Workers, TypeScript
- Cloudflare D1 (SQLite)
- HighLevel API v2 (OAuth marketplace app, SSO custom page)
- Stripe API, read only
- Resend for the sign-in emails
- Vitest, GitHub Actions

## Run it locally

You need Node 22.

```
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

`db:local` applies the migrations and loads `scripts/seed-dev.sql`, an invented property business with about a year of payments. No real names or amounts. Open the local URL and the page signs you in as the preview viewer.

Tests and typecheck:

```
npm test
npm run typecheck
```

To regenerate the seed: `node scripts/gen-seed.mjs`.

## Deploy your own

1. Create a D1 database: `npx wrangler d1 create ledger`. Put its id in `wrangler.toml` in place of `YOUR_D1_DATABASE_ID`, and your account id in place of `YOUR_ACCOUNT_ID`.
2. Set `MAIL_FROM`, `PUBLIC_HOSTS` and `FRAME_ANCESTORS` in `wrangler.toml` for your domains.
3. Set the secrets with `npx wrangler secret put`: `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_REDIRECT_URI`, `GHL_SSO_SHARED_SECRET`, `RESEND_API_KEY`. On Windows, `scripts/deploy.ps1` applies migrations, deploys, and creates `SESSION_SECRET`, `ENC_KEY` and the admin secret for you. Otherwise set those three yourself (`ADMIN_SECRET_SHA256` is the SHA-256 hex of your admin secret).
4. `npm run db:remote` then `npm run deploy`.
5. In your HighLevel marketplace app: custom page URL is the Worker root `/`, OAuth redirect is `/oauth/callback`, scopes are `payments/transactions.readonly`, `contacts.readonly`, `locations.readonly`, `invoices.readonly`.
6. Install the app on a sub-account, then load its config and Stripe key with your admin secret:

```
curl -X POST https://<your-worker>/admin/config -H "X-Admin-Secret: <secret>" -H "Content-Type: application/json" \
  -d '{"locationId":"<location id>","config":<contents of your config.json>}'
curl -X POST https://<your-worker>/admin/stripe-key -H "X-Admin-Secret: <secret>" -H "Content-Type: application/json" \
  -d '{"locationId":"<location id>","key":"<restricted read-only key>"}'
curl -X POST https://<your-worker>/admin/sync -H "X-Admin-Secret: <secret>" -H "Content-Type: application/json" \
  -d '{"locationId":"<location id>"}'
```

## The config

Rules run top to bottom and the first match wins. A rule can match on income type, invoice title, payer, the sub-account the payment came from, or a contact tag or address. `"space": "$address"` uses the tenant's address as the space label, tidied so that "120 main st, suite 3" and "120 Main ST, Suite 3" become one suite. `spaceAliases` holds address fixes that only make sense for your own portfolio. `overrides` lets you set one payment by hand, with a note that shows in the report.

## Status

Running in production for one client. This public copy has that client's config, names, domains and ids taken out. The logic is the same code.

## License

MIT
