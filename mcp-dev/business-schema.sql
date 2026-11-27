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

-- A single immutable opening ledger; historical transactions already affected these balances.
CREATE TABLE IF NOT EXISTS wallet_opening (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  digest TEXT NOT NULL,
  ledger_json TEXT NOT NULL CHECK (json_valid(ledger_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_checkpoints (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL, operation_id TEXT NOT NULL, ledger_json TEXT NOT NULL CHECK(json_valid(ledger_json))
) STRICT;

CREATE TABLE IF NOT EXISTS wallet_checkpoint_receipts (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, digest TEXT NOT NULL
) STRICT;

CREATE VIEW IF NOT EXISTS wallet_effective_opening AS
  SELECT singleton,revision,ledger_json FROM wallet_checkpoints
  UNION ALL SELECT singleton,0,ledger_json FROM wallet_opening WHERE NOT EXISTS(SELECT 1 FROM wallet_checkpoints);

CREATE VIEW IF NOT EXISTS wallet_latest_version AS
  SELECT max(coalesce((SELECT max(revision) FROM wallet_transactions),0),coalesce((SELECT revision FROM wallet_checkpoints WHERE singleton=1),0)) AS revision;

CREATE TABLE IF NOT EXISTS wallet_posting_balances (
  operation_id TEXT NOT NULL, account TEXT NOT NULL, before_fen INTEGER NOT NULL, after_fen INTEGER NOT NULL,
  PRIMARY KEY(operation_id,account)
) STRICT;

CREATE TRIGGER IF NOT EXISTS wallet_posting_capture BEFORE INSERT ON wallet_transactions
WHEN NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE operation_id=NEW.operation_id)
BEGIN
  INSERT INTO wallet_posting_balances SELECT NEW.operation_id,id,balance_fen,balance_fen+
    CASE WHEN id=NEW.to_account_id OR NEW.kind IN ('income','refund') THEN NEW.amount_fen ELSE -NEW.amount_fen END
    FROM wallet_accounts WHERE id IN(NEW.account_id,NEW.to_account_id);
END;
