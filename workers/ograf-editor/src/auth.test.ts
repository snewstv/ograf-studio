import { afterEach, describe, expect, test } from 'bun:test';
import { verifySouvToken } from './auth';

const ENV = { SOUV_API: 'https://api.example.test' };
const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe('verifySouvToken schema handling', () => {
  test('accepts a token the Souv API confirms', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })) as typeof fetch;
    try {
      const hash = await verifySouvToken(ENV, 'good-token-verify-test');
      expect(typeof hash).toBe('string');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects on schema-mismatch errors without throwing', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: 'Cannot query field "ografProjects" on type "Query".' }],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      await expect(verifySouvToken(ENV, 'stale-backend-verify-test')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
