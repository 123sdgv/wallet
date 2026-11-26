import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { insufficientScope } from '@cloudflare/workers-oauth-provider';
import { addLedgerPosting, postingTool, FULL_WRITE } from './financial-write.js';
import { financialReads, FULL_READ, readFinancial } from './financial-read.js';
import { addExpense, readBalance } from './ledger.js';

export const READ = 'wallet:read';
export const WRITE = 'wallet:write';
const uuid = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const empty = { type: 'object', properties: {}, additionalProperties: false };
const schemas = scopes => [{ type: 'oauth2', scopes }];

const readTool = {
  name: 'get_test_balance', title: '查询虚拟余额',
  description: 'Read the isolated synthetic CNY account. Amounts are integer fen (100 fen = 1 yuan).',
  inputSchema: empty,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes: schemas([READ]), _meta: { securitySchemes: schemas([READ]) },
};
const writeTool = {
  name: 'add_test_expense', title: '记录一笔虚拟支出',
  description: 'Only after an explicit request. Read the revision first. Generate one UUID v4 per expense. Retry with identical arguments. On revision conflict, read again and confirm before a new attempt.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['operation_id', 'expected_revision', 'amount_fen'],
    properties: {
      operation_id: { type: 'string', pattern: uuid },
      expected_revision: { type: 'integer', minimum: 0, maximum: 10000 },
      amount_fen: { type: 'integer', minimum: 1, maximum: 1000, description: 'Synthetic expense in fen, 1–1000 (CNY 0.01–10).' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  securitySchemes: schemas([READ, WRITE]), _meta: { securitySchemes: schemas([READ, WRITE]) },
};

function invalid() {
  throw new McpError(ErrorCode.InvalidParams, 'Invalid test tool arguments.');
}
export function validExpense(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (Object.keys(args).length !== 3 || typeof args.operation_id !== 'string' || !new RegExp(uuid).test(args.operation_id)
      || !Number.isInteger(args.amount_fen) || args.amount_fen < 1 || args.amount_fen > 1000
      || !Number.isInteger(args.expected_revision) || args.expected_revision < 0 || args.expected_revision > 10000) return false;
  return true;
}
function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: Boolean(data.error) };
}

export async function serveMcp(request, db, auth, businessDb) {
  if (!auth.scope.includes(READ)) return insufficientScope(auth, [READ]);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415 });
  let body;
  try { body = await request.json(); } catch { return new Response(null, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response(null, { status: 400 });
  if (body.method === 'tools/call' && body.params?.name === writeTool.name && !auth.scope.includes(WRITE)) {
    return insufficientScope(auth, [READ, WRITE]);
  }
  const extra = businessDb ? financialReads : [];
  if (body.method === 'tools/call' && extra.some(t => t.name === body.params?.name) && !auth.scope.includes(FULL_READ)) {
    return insufficientScope(auth, [READ, FULL_READ]);
  }
  if (businessDb && body.method === 'tools/call' && body.params?.name === postingTool.name
      && (!auth.scope.includes(FULL_WRITE) || !auth.scope.includes(FULL_READ))) {
    return insufficientScope(auth, [READ, FULL_READ, FULL_WRITE]);
  }
  const server = new Server({ name: 'wallet-mcp-dev', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: businessDb ? [readTool, writeTool, ...extra, postingTool] : [readTool, writeTool] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    try {
      if (params.name === readTool.name) {
        if (Object.keys(args).length) invalid();
        return result(await readBalance(db));
      }
      if (businessDb && params.name === postingTool.name) return result(await addLedgerPosting(businessDb, args));
      if (extra.some(t => t.name === params.name)) {
        const response = await readFinancial(businessDb, params.name, args);
        if (response.error === 'invalid_arguments') invalid();
        return result(response);
      }
      if (params.name !== writeTool.name) throw new McpError(ErrorCode.MethodNotFound, 'Unknown test tool.');
      if (!validExpense(args)) invalid();
      return result(await addExpense(db, args));
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(ErrorCode.InternalError, 'Test ledger unavailable. Retry with the same operation ID.');
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request, { parsedBody: body }); }
  finally { await server.close(); }
}
