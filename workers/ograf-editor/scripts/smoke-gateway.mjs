// Gateway smoke test (OG-028G). Worker must already run, e.g.:
//   terminal 1: npx wrangler dev --local --port 4321 [--var SOUV_API:<souv>]
//   terminal 2: bun workers/ograf-editor/scripts/smoke-gateway.mjs
// Env: GATEWAY_BASE (default http://127.0.0.1:4321), SMOKE_TOKEN (default smoke-token),
//      WITH_TAB=1 to also exercise the tab roundtrip with a fake tab socket.
// Auth-positive checks need a reachable SOUV_API; without it only the 401
// paths are expected to pass (run with EXPECT_AUTH_FAIL=1 in that case).
// Exits non-zero on any failed expectation.
import { MCP_TOOL_NAMES } from '../src/catalog.ts';

const base = (process.env.GATEWAY_BASE ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const token = process.env.SMOKE_TOKEN ?? 'smoke-token';
const expectAuthFail = process.env.EXPECT_AUTH_FAIL === '1';
const withTab = process.env.WITH_TAB === '1';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const FETCH_TIMEOUT_MS = 20000;

const requestInit = (extra = {}) => ({ ...extra, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

process.on('unhandledRejection', (error) => {
  console.log(
    `FAIL worker unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

let failures = 0;
const check = (label, cond, extra) => {
  console.log(
    `${cond ? 'PASS' : 'FAIL'} ${label}${cond || extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 200)}`}`,
  );
  if (!cond) failures++;
};

const post = async (payload, useAuth = true) => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: useAuth ? headers : { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// 1. no token -> 401 (no Souv needed)
{
  const res = await fetch(
    `${base}/mcp`,
    requestInit({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping', params: {} }),
    }),
  );
  check('mcp without token is 401', res.status === 401, res.status);
}

if (expectAuthFail) {
  console.log(
    'EXPECT_AUTH_FAIL=1: skipping auth-positive checks (Souv unreachable from this sandbox).',
  );
  process.exit(failures ? 1 : 0);
}

// 2. initialize negotiates the requested known version
{
  const { status, json } = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  check(
    'initialize 200 + serverInfo',
    status === 200 && json?.result?.serverInfo?.name === 'ograf-studio-gateway',
    json,
  );
}

// 3. tools/list matches the shared catalog
{
  const { json } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (json?.result?.tools ?? []).map((t) => t.name);
  check(
    'tools/list matches catalog',
    JSON.stringify(names) === JSON.stringify([...MCP_TOOL_NAMES]),
    names.length,
  );
}

// 4. capabilities answers inline (no tab needed)
{
  const { json } = await post({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'ograf_get_capabilities', arguments: {} },
  });
  check(
    'capabilities inline',
    json?.result?.content?.[0]?.text?.includes('mcp-gateway') === true,
    json,
  );
}

// 5. unknown tool -> -32602
{
  const { json } = await post({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  });
  check('unknown tool is -32602', json?.error?.code === -32602, json);
}

if (withTab) {
  // 6. fake tab roundtrip: bridge socket auto-replies, call must route through it
  const ws = new WebSocket(`ws://${new URL(base).host}/bridge?token=${encodeURIComponent(token)}`);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge open timeout')), 10000);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(t);
        ws.send(JSON.stringify({ type: 'bridge.hello' }));
        resolve();
      },
      { once: true },
    );
    ws.addEventListener('error', (e) => reject(new Error(`bridge error: ${e.message ?? e.type}`)));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'tool.call') {
      ws.send(
        JSON.stringify({
          type: 'tool.result',
          callId: msg.callId,
          ok: true,
          result: { echo: msg.name },
        }),
      );
    }
  });
  await new Promise((r) => setTimeout(r, 1000));
  const { json } = await post({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'ograf_get_timeline', arguments: {} },
  });
  check(
    'call routes to tab and back',
    (json?.result?.content?.[0]?.text ?? '').includes('ograf_get_timeline'),
    json,
  );
  ws.close();
} else {
  // 6b. without a tab the call must fail closed with -32001
  const { json } = await post({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'ograf_get_timeline', arguments: {} },
  });
  check('call without tab is -32001', json?.error?.code === -32001, json);
}

process.exit(failures ? 1 : 0);
