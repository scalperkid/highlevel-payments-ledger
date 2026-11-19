-- Who opened the reports, and when. Email, time and Cloudflare's coarse location only; no IP address.
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  email TEXT,
  event TEXT NOT NULL,          -- open | denied | close | download
  detail TEXT,
  city TEXT,
  region TEXT,
  country TEXT,
  colo TEXT
);
CREATE INDEX IF NOT EXISTS access_log_loc_at ON access_log (location_id, at);
