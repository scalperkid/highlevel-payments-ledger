-- A closed month is a frozen snapshot: later rule or data changes never alter it.
CREATE TABLE month_closes (
  location_id   TEXT NOT NULL,
  month         TEXT NOT NULL,          -- YYYY-MM
  closed_at     INTEGER NOT NULL,
  closed_by     TEXT NOT NULL,
  summary_json  TEXT NOT NULL,
  lines_csv     TEXT NOT NULL,
  summary_csv   TEXT NOT NULL,
  quickbooks_csv TEXT NOT NULL,
  PRIMARY KEY (location_id, month)
);
