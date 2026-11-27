-- Dedicated disposable P0 database only. The opening row is synthetic.
CREATE TABLE IF NOT EXISTS wallet_probe (
  revision INTEGER PRIMARY KEY CHECK (revision >= 0),
  operation_id TEXT UNIQUE,
  expense_fen INTEGER NOT NULL,
  balance_fen INTEGER NOT NULL CHECK (balance_fen BETWEEN 0 AND 10000),
  recorded_at TEXT NOT NULL,
  CHECK (
    (revision = 0 AND operation_id IS NULL AND expense_fen = 0 AND balance_fen = 10000)
    OR (revision > 0 AND operation_id IS NOT NULL AND expense_fen BETWEEN 1 AND 1000)
  )
) STRICT;

INSERT INTO wallet_probe (revision, operation_id, expense_fen, balance_fen, recorded_at)
VALUES (0, NULL, 0, 10000, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(revision) DO NOTHING;

-- Only the identifier and the absolute device authorization deadline are retained.
CREATE TABLE IF NOT EXISTS wallet_devices (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;
