-- One-time sign-in links for viewers who do not open Reports from the CRM menu (the accountant).
-- Only a hash of each link is stored; a used or expired link cannot be replayed.
CREATE TABLE IF NOT EXISTS signin_links (
  hash TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS signin_links_email_at ON signin_links (email, created_at);
