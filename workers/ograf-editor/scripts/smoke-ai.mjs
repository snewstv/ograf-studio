/**
 * Smoke test for the worker AI chat route (OG-094, no Souv needed).
 *
 * Checks fail-closed paths only: 401 without credentials, 405 on GET.
 * A real turn needs a Souv token + connected tab + AI binding (manual).
 * Run: bun workers/ograf-editor/scripts/smoke-ai.mjs [baseUrl]
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log('ok - ' + name);
  } catch (error) {
    failures += 1;
    console.error(
      'FAIL - ' + name + ': ' + (error instanceof Error ? error.message : String(error)),
    );
  }
}

await check('POST /ai/chat without token is 401', async () => {
  const response = await fetch(base + '/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnId: 't', text: 'hi' }),
  });
  if (response.status !== 401) throw new Error('expected 401, got ' + response.status);
});

await check('GET /ai/chat is 405', async () => {
  const response = await fetch(base + '/ai/chat');
  if (response.status !== 405) throw new Error('expected 405, got ' + response.status);
});

await check('GET /health reports bindings', async () => {
  const response = await fetch(base + '/health');
  if (!response.ok) throw new Error('expected 200, got ' + response.status);
  const body = await response.json();
  if (typeof body.rev !== 'string') throw new Error('missing rev in /health');
  if (!body.bindings || typeof body.bindings.gateway !== 'boolean') {
    throw new Error('missing bindings in /health');
  }
});

if (failures > 0) {
  console.error(failures + ' smoke check(s) failed');
  process.exit(1);
}
console.log('smoke-ai: all green (fail-closed paths only)');
