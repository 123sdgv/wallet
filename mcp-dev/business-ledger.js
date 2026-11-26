// The Worker and phone synchronization layer use integer fen at their boundary.
const amountLimit = 9_000_000_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const id = /^[a-zA-Z0-9_-]{1,96}$/;
const columns = ['kind', 'amount_fen', 'account_id', 'to_account_id', 'local_date', 'tag_id', 'off_budget', 'item', 'note'];
const allowed = new Set(['expected_revision', 'operation_id', ...columns]);
const head = 'SELECT COALESCE(MAX(revision), 0) AS revision FROM wallet_transactions';

function validRevision(value) { return Number.isSafeInteger(value) && value >= 0; }
function validId(value) { return typeof value === 'string' && id.test(value); }
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function values(op) {
  if (!op || typeof op !== 'object' || Object.keys(op).some(key => !allowed.has(key))) return null;
  const { expected_revision, operation_id, kind, amount_fen, account_id, to_account_id = null,
    local_date, tag_id = null, off_budget = false, item = '', note = '' } = op;
  if (!validRevision(expected_revision) || typeof operation_id !== 'string' || !uuid.test(operation_id)
      || !['income', 'expense', 'refund', 'transfer'].includes(kind)
      || !Number.isSafeInteger(amount_fen) || amount_fen < 1 || amount_fen > amountLimit
      || !validId(account_id) || !validDate(local_date) || typeof off_budget !== 'boolean'
      || typeof item !== 'string' || item.length > 256 || typeof note !== 'string' || note.length > 2000) return null;
  if (kind === 'transfer' ? !validId(to_account_id) || account_id === to_account_id : to_account_id !== null) return null;
  if (tag_id !== null && !validId(tag_id)) return null;
  if (!['expense', 'refund'].includes(kind) && (off_budget || tag_id !== null)) return null;
  return [kind, amount_fen, account_id, to_account_id, local_date, tag_id, Number(off_budget), item, note];
}

export async function recordTransaction(db, op) {
  const fields = values(op);
  if (!fields) return { error: 'invalid_transaction' };
  const session = db.withSession('first-primary');
  const insert = session.prepare(`
    INSERT INTO wallet_transactions (revision, operation_id, ${columns.join(', ')})
    SELECT h.revision + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM (${head}) h
      JOIN wallet_accounts a ON a.id = ?
      LEFT JOIN wallet_accounts b ON b.id = ?
     WHERE h.revision = ? AND (? IS NULL OR b.id IS NOT NULL)
       AND abs(a.balance_fen + ?) <= ? AND (b.id IS NULL OR abs(b.balance_fen + ?) <= ?)
    ON CONFLICT(operation_id) DO NOTHING RETURNING revision
  `).bind(op.operation_id, ...fields, op.account_id, op.to_account_id ?? null, op.expected_revision,
    op.to_account_id ?? null, ['income', 'refund'].includes(op.kind) ? op.amount_fen : -op.amount_fen,
    amountLimit, op.amount_fen, amountLimit);
  const [added, receipt, version] = await session.batch([insert,
    session.prepare('SELECT * FROM wallet_transactions WHERE operation_id = ?').bind(op.operation_id),
    session.prepare(head)]);
  const row = receipt.results[0];
  const revision = version.results[0].revision;
  if (!row) return { revision, error: revision !== op.expected_revision ? 'revision_conflict' : 'invalid_account_or_balance' };
  if (row.revision !== op.expected_revision + 1 || columns.some((key, i) => row[key] !== fields[i])) {
    return { error: 'operation_id_reused' };
  }
  return { operation_id: row.operation_id, receipt_revision: row.revision, revision, replayed: !added.results.length };
}

export async function readAccountBalances(db) {
  const session = db.withSession('first-primary');
  const [latest, accounts] = await session.batch([session.prepare(head),
    session.prepare('SELECT id, balance_fen FROM wallet_accounts ORDER BY id')]);
  return { revision: latest.results[0].revision, accounts: accounts.results };
}

// Pass the first page's through_revision on subsequent requests to keep a stable upper bound.
export async function readTransactionChanges(db, after, through = null, limit = 50) {
  if (!validRevision(after) || (through !== null && (!validRevision(through) || through < after))
      || !Number.isInteger(limit) || limit < 1 || limit > 100) return { error: 'invalid_cursor' };
  const session = db.withSession('first-primary');
  const [latest, changes] = await session.batch([session.prepare(head), session.prepare(`
    SELECT * FROM wallet_transactions WHERE revision > ? AND revision <= COALESCE(?, (${head}))
    ORDER BY revision LIMIT ?
  `).bind(after, through, limit)]);
  const revision = latest.results[0].revision;
  if (after > revision || (through !== null && through > revision)) return { error: 'invalid_cursor' };
  const throughRevision = through ?? revision;
  const next = changes.results.at(-1)?.revision ?? after;
  return { through_revision: throughRevision, changes: changes.results, next_revision: next, has_more: next < throughRevision };
}
