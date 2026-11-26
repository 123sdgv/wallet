import { openingLedger } from './opening-ledger.js';
import { changeAsWalletTx } from './financial-read.js';

const head = 'SELECT revision FROM wallet_latest_version';
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;

export async function readFullState(db, knownRevision = -1) {
  const s = db.withSession('first-primary');
  const current = await s.prepare(head).first();
  if (current.revision === knownRevision) return {revision:knownRevision};
  const [opening, version, accounts, postings] = await s.batch([
    s.prepare('SELECT ledger_json FROM wallet_effective_opening'),
    s.prepare(head), s.prepare('SELECT id,balance_fen FROM wallet_accounts'),
    s.prepare('SELECT '+changeAsWalletTx+' AS row FROM wallet_transactions WHERE revision>(SELECT revision FROM wallet_effective_opening) ORDER BY revision DESC'),
  ]);
  if (!opening.results.length) return {error:'ledger_not_initialized'};
  const ledger = JSON.parse(opening.results[0].ledger_json);
  const balances = new Map(accounts.results.map(a=>[a.id,a.balance_fen]));
  for (const a of ledger.accounts) a.balance = balances.get(a.id)/100;
  ledger.txs = [...postings.results.map(p=>JSON.parse(p.row)),...ledger.txs];
  return {revision:version.results[0].revision,ledger};
}

export async function acceptFullState(db, args) {
  if (!args || !uuid.test(args.operation_id) || !Number.isSafeInteger(args.expected_revision) || args.expected_revision<0) return {error:'invalid_arguments'};
  let ledger;
  try { ({ledger} = openingLedger(args.ledger)); } catch { return {error:'ledger_needs_review'}; }
  const json=JSON.stringify(ledger), bytes=new TextEncoder().encode(json);
  if (bytes.length>512*1024) return {error:'ledger_too_large'};
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  const s=db.withSession('first-primary'), id=args.operation_id, next=args.expected_revision+1;
  // A receipt gates every side effect in the same D1 transaction. A replay cannot restore an earlier checkpoint.
  const [receipt, , , saved, version]=await s.batch([
    s.prepare(`INSERT INTO wallet_checkpoint_receipts(id,revision,digest) SELECT ?,?,? WHERE (SELECT revision FROM wallet_latest_version)=?
      AND EXISTS(SELECT 1 FROM wallet_opening) AND NOT EXISTS(SELECT 1 FROM wallet_transactions WHERE operation_id=?)
      ON CONFLICT DO NOTHING RETURNING revision`).bind(id,next,digest,args.expected_revision,id),
    s.prepare(`INSERT INTO wallet_checkpoints(singleton,revision,operation_id,ledger_json) SELECT 1,?,?,? WHERE changes()>0
      ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,operation_id=excluded.operation_id,ledger_json=excluded.ledger_json`).bind(next,id,json),
    s.prepare(`INSERT INTO wallet_accounts(id,balance_fen)
      SELECT json_extract(j.value,'$.id'),CAST(round(json_extract(j.value,'$.balance')*100) AS INTEGER)
      FROM wallet_checkpoints c,json_each(c.ledger_json,'$.accounts') j WHERE changes()>0 AND c.operation_id=?
      ON CONFLICT(id) DO UPDATE SET balance_fen=excluded.balance_fen`).bind(id),
    s.prepare('SELECT revision,digest FROM wallet_checkpoint_receipts WHERE id=?').bind(id),s.prepare(head),
  ]);
  const stored=saved.results[0], revision=version.results[0].revision;
  if (!stored) return {error:'revision_conflict',revision};
  if (stored.digest !== digest || stored.revision !== next) return {error:'operation_id_reused'};
  return {revision,receipt_revision:next,replayed:receipt.results.length===0};
}
