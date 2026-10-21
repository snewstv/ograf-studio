import { afterEach, describe, expect, test } from 'bun:test';
import { GatewayDO } from './gatewayDO';

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
});

function mcpRequest(token?: string): Request {
  return new Request('https://worker.test/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
}

describe('GatewayDO token-check cache', () => {
  test('introspects Souv once per TTL per login stub', async () => {
    let introspections = 0;
    globalThis.fetch = (async () => {
      introspections += 1;
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch;
    const stub = new GatewayDO({} as DurableObjectState, {
      SOUV_API: 'https://api.example.test',
    });
    try {
      const first = await stub.fetch(mcpRequest('tok-cache-test'));
      expect(first.status).toBe(200);
      const second = await stub.fetch(mcpRequest('tok-cache-test'));
      expect(second.status).toBe(200);
      expect(introspections).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects without introspecting when the token is missing', async () => {
    let introspections = 0;
    globalThis.fetch = (async () => {
      introspections += 1;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;
    const stub = new GatewayDO({} as DurableObjectState, {
      SOUV_API: 'https://api.example.test',
    });
    try {
      const response = await stub.fetch(mcpRequest());
      expect(response.status).toBe(401);
      expect(introspections).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
