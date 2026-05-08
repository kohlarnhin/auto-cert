CREATE TABLE IF NOT EXISTS certificates (
  domain          TEXT PRIMARY KEY,
  wildcard_domain TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  cf_token        TEXT NOT NULL,
  fullchain_key   TEXT,
  privkey_key     TEXT,
  metadata_key    TEXT,
  status          TEXT NOT NULL DEFAULT 'none',
  issued_at       TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acme_accounts (
  domain          TEXT PRIMARY KEY,
  account_key_pem TEXT NOT NULL,
  account_url     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS apply_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain     TEXT NOT NULL,
  step       TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_certificates_status
  ON certificates(status);

CREATE INDEX IF NOT EXISTS idx_apply_events_domain_id
  ON apply_events(domain, id);
