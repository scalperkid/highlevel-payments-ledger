-- Payments ledger schema. Every table is keyed by location_id so one deploy
-- serves any number of sub-accounts.

-- OAuth tokens from the marketplace app install. Encrypted at rest (AES-GCM, ENC_KEY).
CREATE TABLE installs (
  location_id      TEXT PRIMARY KEY,
  company_id       TEXT,
  access_enc       TEXT NOT NULL,
  refresh_enc      TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  scope            TEXT,
  user_type        TEXT,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE install_attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  location_id      TEXT,
  status           TEXT NOT NULL,
  detail           TEXT
);

-- Per-location configuration: display name, viewers, segment rules. Data, not code.
CREATE TABLE location_config (
  location_id      TEXT PRIMARY KEY,
  config_json      TEXT NOT NULL,
  stripe_key_enc   TEXT,
  updated_at       INTEGER NOT NULL
);

-- One row per money movement. Stripe rows keyed by balance transaction id,
-- CRM rows keyed by "crm:<id>".
CREATE TABLE payments (
  id               TEXT NOT NULL,
  location_id      TEXT NOT NULL,
  source           TEXT NOT NULL,          -- 'stripe' | 'crm'
  kind             TEXT NOT NULL,          -- payment | reversal | fee | crm_manual | crm_stripe
  status           TEXT NOT NULL,          -- succeeded | failed | refunded
  occurred_at      INTEGER NOT NULL,       -- unix seconds
  gross_cents      INTEGER NOT NULL,
  fee_cents        INTEGER NOT NULL DEFAULT 0,
  net_cents        INTEGER NOT NULL,
  method           TEXT,
  payer            TEXT,
  contact_id       TEXT,
  title            TEXT,
  payment_intent   TEXT,
  origin_location  TEXT,
  payout_id        TEXT,
  PRIMARY KEY (location_id, id)
);
CREATE INDEX payments_time ON payments (location_id, occurred_at);
CREATE INDEX payments_pi ON payments (location_id, payment_intent);

CREATE TABLE payouts (
  id               TEXT NOT NULL,
  location_id      TEXT NOT NULL,
  arrival_at       INTEGER,
  amount_cents     INTEGER NOT NULL,
  status           TEXT,
  mapped           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, id)
);

CREATE TABLE contacts (
  location_id      TEXT NOT NULL,
  contact_id       TEXT NOT NULL,
  name             TEXT,
  company          TEXT,
  address          TEXT,
  tags_json        TEXT,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (location_id, contact_id)
);

CREATE TABLE sync_state (
  location_id      TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT,
  PRIMARY KEY (location_id, key)
);

CREATE TABLE sync_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id      TEXT NOT NULL,
  at               INTEGER NOT NULL,
  step             TEXT NOT NULL,
  ok               INTEGER NOT NULL,
  detail           TEXT
);
