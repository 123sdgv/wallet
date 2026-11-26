-- Business ledger schema. Opening balances are supplied separately on explicit initialization.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  balance_fen INTEGER NOT NULL CHECK (abs(balance_fen) <= 9000000000000)
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  operation_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense','refund','transfer')),
  amount_fen INTEGER NOT NULL CHECK (amount_fen BETWEEN 1 AND 9000000000000),
  account_id TEXT NOT NULL REFERENCES wallet_accounts(id),
  to_account_id TEXT REFERENCES wallet_accounts(id),
  local_date TEXT NOT NULL,
  tag_id TEXT,
  off_budget INTEGER NOT NULL CHECK (off_budget IN (0,1)),
  item TEXT NOT NULL,
  note TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((kind = 'transfer') = (to_account_id IS NOT NULL)),
  CHECK (to_account_id IS NULL OR to_account_id <> account_id),
  CHECK (kind IN ('expense','refund') OR (off_budget = 0 AND tag_id IS NULL))
) STRICT;

-- The entry, version, operation receipt and balance effects commit as a single SQLite statement.
CREATE TRIGGER IF NOT EXISTS wallet_transaction_apply
AFTER INSERT ON wallet_transactions
BEGIN
  UPDATE wallet_accounts SET balance_fen = balance_fen +
    CASE WHEN NEW.kind IN ('income','refund') THEN NEW.amount_fen ELSE -NEW.amount_fen END
    WHERE id = NEW.account_id;
  UPDATE wallet_accounts SET balance_fen = balance_fen + NEW.amount_fen WHERE id = NEW.to_account_id;
END;
