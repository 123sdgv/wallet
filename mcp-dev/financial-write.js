import { recordTransaction } from './business-ledger.js';
import { FULL_READ } from './financial-read.js';

export const FULL_WRITE = 'wallet:ledger:write';
const schemes = [{ type: 'oauth2', scopes: ['wallet:read', FULL_READ, FULL_WRITE] }];
export const postingTool = {
  name: 'add_ledger_transaction', title: '新增账本流水',
  description: 'Only on an explicit instruction to record a transaction. Use known account IDs, a positive amount in CNY fen, the user’s local date, and the last observed revision. For transfers require two different accounts. For a retry keep the same UUID and all original arguments. On revision conflict reread and confirm. This records bookkeeping only.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['operation_id','expected_revision','kind','amount_fen','account_id','local_date'],
    properties: { operation_id: {type:'string',format:'uuid'}, expected_revision:{type:'integer',minimum:0},
      kind:{type:'string',enum:['expense','income','transfer','refund']},amount_fen:{type:'integer',minimum:1,maximum:9000000000000},
      account_id:{type:'string',maxLength:96},to_account_id:{type:'string',maxLength:96},local_date:{type:'string',format:'date'},
      tag_id:{type:'string',maxLength:96},off_budget:{type:'boolean'},item:{type:'string',maxLength:256},note:{type:'string',maxLength:2000} } },
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  securitySchemes:schemes,_meta:{securitySchemes:schemes},
};

export async function addLedgerPosting(db,args) {
  const session=db.withSession('first-primary');
  const opening=await session.prepare('SELECT ledger_json FROM wallet_effective_opening WHERE singleton=1').first();
  if (!opening) return {error:'ledger_not_initialized'};
  if (!args || typeof args.operation_id !== 'string') return {error:'invalid_transaction'};
  const prior=await session.prepare('SELECT 1 AS present FROM wallet_transactions WHERE operation_id=?').bind(args.operation_id).first();
  if (!prior) {
    const current=JSON.parse(opening.ledger_json);
    const ids=new Set(current.accounts.map(a=>a.id));
    if (!ids.has(args.account_id) || (args.to_account_id != null && !ids.has(args.to_account_id))) return {error:'invalid_account_or_balance'};
    if (args.tag_id != null && !current.tags.some(t=>t.id===args.tag_id)) return {error:'unknown_tag'};
    if (current.txs.some(t=>t.id===args.operation_id)) return {error:'operation_id_reused'};
  }
  const receipt=await recordTransaction(db,args);
  if (receipt.error) return receipt;
  const captured = await session.prepare('SELECT account AS id,before_fen,after_fen FROM wallet_posting_balances WHERE operation_id=? ORDER BY account').bind(args.operation_id).all();
  if (captured.results.length) return {...receipt,transaction_id:receipt.operation_id,currency:'CNY',account_changes:captured.results};
  // Reconstruct this receipt's balances, even if another transaction committed before a retry.
  const result=await session.prepare(`WITH diffs(account,rev,delta) AS (
    SELECT account_id,revision,CASE kind WHEN 'refund' THEN amount_fen WHEN 'income' THEN amount_fen ELSE -amount_fen END
      FROM wallet_transactions WHERE account_id IN (?,?) AND revision>=?
    UNION ALL SELECT to_account_id,revision,amount_fen FROM wallet_transactions WHERE to_account_id IN (?,?) AND revision>=?
  ) SELECT a.id,a.balance_fen - COALESCE(sum(d.delta),0) AS before_fen,
    a.balance_fen - COALESCE(sum(CASE WHEN d.rev>? THEN d.delta ELSE 0 END),0) AS after_fen
    FROM wallet_accounts a LEFT JOIN diffs d ON d.account=a.id WHERE a.id IN (?,?) GROUP BY a.id ORDER BY a.id`)
    .bind(args.account_id,args.to_account_id??null,receipt.receipt_revision,args.account_id,args.to_account_id??null,
      receipt.receipt_revision,receipt.receipt_revision,args.account_id,args.to_account_id??null).all();
  return {...receipt,transaction_id:receipt.operation_id,currency:'CNY',account_changes:result.results};
}
