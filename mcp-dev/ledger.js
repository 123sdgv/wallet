const latest = 'SELECT * FROM wallet_probe ORDER BY revision DESC LIMIT 1';

function snapshot(row) {
  return {
    dataset: 'synthetic', currency: 'CNY', balance_fen: row.balance_fen,
    revision: row.revision, last_change_at: row.recorded_at,
    as_of: new Date().toISOString(), phone_sync: 'disconnected',
  };
}

export async function readBalance(db) {
  const row = await db.withSession('first-primary').prepare(latest).first();
  return snapshot(row);
}

export async function addExpense(db, { operation_id, expected_revision, amount_fen }) {
  const session = db.withSession('first-primary');
  // The insert reads the current head inside the same SQLite write statement.
  // The unique operation ID and the revision are constraints on the very same row.
  const insert = session.prepare(`
    INSERT INTO wallet_probe (revision, operation_id, expense_fen, balance_fen, recorded_at)
    SELECT revision + 1, ?, ?, balance_fen - ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM (${latest})
    WHERE revision = ? AND balance_fen >= ?
    ON CONFLICT DO NOTHING
    RETURNING revision
  `).bind(operation_id, amount_fen, amount_fen, expected_revision, amount_fen);
  const receipt = session.prepare('SELECT * FROM wallet_probe WHERE operation_id = ?').bind(operation_id);
  const [inserted, stored, head] = await session.batch([insert, receipt, session.prepare(latest)]);
  const row = stored.results[0];
  if (!row) {
    const state = snapshot(head.results[0]);
    return { error: state.revision === expected_revision ? 'insufficient_funds' : 'revision_conflict', ...state };
  }
  if (row.expense_fen !== amount_fen || row.revision !== expected_revision + 1) {
    return { error: 'operation_id_reused' };
  }
  return {
    ...snapshot(head.results[0]), operation_id, replayed: !inserted.results.length,
    expense_fen: amount_fen, receipt_revision: row.revision,
    before_fen: row.balance_fen + amount_fen, after_fen: row.balance_fen,
  };
}
