import { describe, expect, test } from 'bun:test';
import {
  AI_DEFAULT_MODEL,
  AI_MAX_TOOL_CALLS,
  coerceToolArgs,
  extractAssistantText,
  extractToolCalls,
  handleAiChat,
  normalizeToolCalls,
  toWorkersAITools,
} from './aiChat';
import { MCP_OPERATION_TYPES, MCP_TOOL_NAMES } from './catalog';
import { respondToMessage } from './mcpRouter';

const ENV = { SOUV_API: 'https://api.example.test' };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function readEvents(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.slice('data:'.length)) as Record<string, unknown>);
}

describe('worker AI chat (OG-090/OG-091)', () => {
  test('rejects missing/invalid credentials and methods', async () => {
    const noAuth = await handleAiChat(post({ turnId: 't', text: 'hi' }), ENV, {
      verifyToken: async () => 'hash',
    });
    expect(noAuth.status).toBe(401);
    const badToken = await handleAiChat(
      post({ turnId: 't', text: 'hi' }, { Authorization: 'Bearer bad' }),
      ENV,
      { verifyToken: async () => null },
    );
    expect(badToken.status).toBe(401);
    const get = await handleAiChat(new Request('https://worker.test/ai/chat'), ENV);
    expect(get.status).toBe(405);
    const noBinding = await handleAiChat(
      post({ turnId: 't', text: 'hi' }, { Authorization: 'Bearer good' }),
      ENV,
      { verifyToken: async () => 'hash' },
    );
    expect(noBinding.status).toBe(500);
  });

  test('rejects malformed turns', async () => {
    const runModel = async () => ({ response: 'ok' });
    for (const body of [
      {},
      { turnId: '', text: 'hi' },
      { turnId: 't' },
      { turnId: 't', text: '  ' },
    ]) {
      const response = await handleAiChat(post(body, { Authorization: 'Bearer good' }), ENV, {
        verifyToken: async () => 'hash',
        runModel: runModel,
      });
      expect(response.status).toBe(400);
    }
  });

  test('single text turn emits config, text and turn.end', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const response = await handleAiChat(
      post(
        { turnId: 'turn-1', sessionId: 'editor:abc', text: 'Hello', history: [] },
        { Authorization: 'Bearer good' },
      ),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async (model, input) => {
          seen.push({ model: model, tools: (input.tools as unknown[]).length });
          return { response: 'Hi there', usage: { prompt_tokens: 10, completion_tokens: 3 } };
        },
        callTabTool: async () => {
          throw new Error('must not call the tab without tool calls');
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const events = await readEvents(response);
    expect(events[0]).toMatchObject({
      type: 'chat.config',
      turnId: 'turn-1',
      configured: true,
      provider: 'workers-ai',
      model: AI_DEFAULT_MODEL,
    });
    expect(events).toContainEqual({ type: 'chat.text', turnId: 'turn-1', text: 'Hi there' });
    const end = events.find((event) => event.type === 'chat.turn.end') as {
      stopReason: string;
      usage: { input: number; output: number };
    };
    expect(end.stopReason).toBe('done');
    expect(end.usage).toMatchObject({ input: 10, output: 3 });
    expect(seen).toEqual([{ model: AI_DEFAULT_MODEL, tools: MCP_TOOL_NAMES.length }]);
  });

  test('tool calls fan out to the tab and results continue the loop', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'turn-2', text: 'How many layers?' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [{ id: 'c1', name: 'ograf_get_timeline', arguments: {} }],
            };
          }
          return { response: 'Three layers.' };
        },
        callTabTool: async (_token, name, args) => {
          calls.push({ name: name, args: args });
          return { ok: true, result: { compositions: 1 } };
        },
      },
    );
    const events = await readEvents(response);
    expect(calls).toEqual([{ name: 'ograf_get_timeline', args: {} }]);
    expect(events.map((event) => event.type)).toEqual([
      'chat.config',
      'chat.progress',
      'chat.tool',
      'chat.tool',
      'chat.progress',
      'chat.text',
      'chat.turn.end',
    ]);
    const statuses = events
      .filter((event) => event.type === 'chat.tool')
      .map((event) => event.status);
    expect(statuses).toEqual(['running', 'ok']);
    expect(events).toContainEqual({ type: 'chat.text', turnId: 'turn-2', text: 'Three layers.' });
  });

  test('failed tab calls surface as chat errors, not hangs', async () => {
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'turn-3', text: 'Undo that' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [{ id: 'c9', name: 'ograf_undo', arguments: {} }],
            };
          }
          return { response: 'Could not undo: the tab is not connected.' };
        },
        callTabTool: async () => ({ ok: false, error: 'The editor tab is not connected.' }),
      },
    );
    const events = await readEvents(response);
    const last = events[events.length - 1] as { type: string; message?: string };
    expect(last.type).toBe('chat.turn.end');
    expect(events.some((event) => event.type === 'chat.tool' && event.status === 'error')).toBe(
      true,
    );
    // A failed tool still feeds the transcript back to the model once.
    expect(events.filter((event) => event.type === 'chat.progress')).toHaveLength(2);
  });

  test('tool errors feed a retry directive back to the model within the turn', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tabCalls: Array<Record<string, unknown>> = [];
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'turn-retry', text: 'Make the card green' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async (_model, input) => {
          rounds += 1;
          seen.push(input);
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [
                {
                  id: 'r1',
                  name: 'ograf_apply_operations',
                  arguments: {
                    mode: 'apply',
                    expectedRevision: 0,
                    operations: [{ type: 'update_element', layerId: 'layer-1' }],
                  },
                },
              ],
            };
          }
          if (rounds === 2) {
            return {
              response: '',
              tool_calls: [
                {
                  id: 'r2',
                  name: 'ograf_apply_operations',
                  arguments: {
                    mode: 'apply',
                    expectedRevision: 0,
                    operations: [
                      { type: 'update_element', layerId: 'layer-1', patch: { fill: '#00ff00' } },
                    ],
                  },
                },
              ],
            };
          }
          return { response: 'Card is green now.' };
        },
        callTabTool: async (_token, name, args) => {
          tabCalls.push({ name: name, args: args });
          const ops = (args.operations ?? []) as Array<Record<string, unknown>>;
          const first = ops[0] as Record<string, unknown> | undefined;
          if (!first || typeof first.patch !== 'object' || first.patch === null) {
            return { ok: false, error: 'Operation 0: update_element requires a patch object.' };
          }
          return { ok: true, result: { mode: 'apply', applied: true, operationCount: 1 } };
        },
      },
    );
    const events = await readEvents(response);
    const statuses = events
      .filter((event) => event.type === 'chat.tool')
      .map((event) => event.status);
    expect(statuses).toEqual(['running', 'error', 'running', 'ok']);
    const secondInput = seen[1] as { messages: Array<Record<string, unknown>> };
    const toolMsg = secondInput.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('requires a patch object');
    expect(toolMsg.content).toContain('do not end the turn');
    expect(tabCalls).toHaveLength(2);
    expect(events).toContainEqual({
      type: 'chat.text',
      turnId: 'turn-retry',
      text: 'Card is green now.',
    });
    const end = events.find((event) => event.type === 'chat.turn.end') as { stopReason: string };
    expect(end.stopReason).toBe('done');
  });

  test('tool-call parsing accepts stringified arguments and skips junk', () => {
    expect(
      normalizeToolCalls([
        { id: 'a', name: 'ograf_undo', arguments: '{"x":1}' },
        { name: 'ograf_redo', arguments: {} },
        { nope: true },
        null,
        'junk',
      ]),
    ).toEqual([
      { id: 'a', name: 'ograf_undo', args: { x: 1 } },
      { id: expect.any(String), name: 'ograf_redo', args: {} },
    ]);
    expect(normalizeToolCalls(undefined)).toEqual([]);
  });

  test('tool definitions mirror the shared catalog (no drift by hand)', () => {
    const tools = toWorkersAITools();
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    const apply = tools.find((tool) => tool.name === 'ograf_apply_operations');
    expect(apply?.parameters).toMatchObject({ required: ['expectedRevision', 'operations'] });
    // Fase 6B: creation steering must not regress — ADD prompts failed
    // silently when only update_* had a documented example.
    expect(apply?.description).toMatch(/add_layer/);
    expect(apply?.description).toMatch(/"content"/);
    expect(apply?.description).toMatch(/rectangle/);
    expect(apply?.description).toMatch(/image-sequence/);
    expect(AI_MAX_TOOL_CALLS).toBeGreaterThan(0);
  });

  test('MCP tools/list matches the AI function definitions (parity)', async () => {
    const listed = await respondToMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        callTab: async () => {
          throw new Error('tools/list must not reach the tab');
        },
      },
    );
    const mcpTools = (listed as { result: { tools: Array<{ name: string; description: string }> } })
      .result.tools;
    const aiTools = toWorkersAITools();
    expect(mcpTools.map((tool) => tool.name)).toEqual(aiTools.map((tool) => tool.name));
    expect(mcpTools.map((tool) => tool.description)).toEqual(
      aiTools.map((tool) => tool.description),
    );
    const mcpSchemas = (
      listed as { result: { tools: Array<{ inputSchema: unknown }> } }
    ).result.tools.map((tool) => tool.inputSchema);
    expect(mcpSchemas).toEqual(aiTools.map((tool) => tool.parameters));
  });
});

describe('worker AI chat budgets and cumulative usage (review fixes)', () => {
  test('long transcripts are cut oldest-first under the history budget', async () => {
    let seenMessages: Array<{ role: string; content?: unknown }> = [];
    const history = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      text: 'm' + i + '-' + 'x'.repeat(3000),
    }));
    const response = await handleAiChat(
      post({ turnId: 'b-history', text: 'hi', history: history }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async (_model, input) => {
          seenMessages = input.messages as Array<{ role: string; content?: unknown }>;
          return { response: 'ok' };
        },
        callTabTool: async () => {
          throw new Error('no tools expected');
        },
      },
    );
    const events = await readEvents(response);
    expect(events[events.length - 1]).toMatchObject({
      type: 'chat.turn.end',
      stopReason: 'done',
    });
    const historyOnly = seenMessages.slice(1, -1).map((m) => String(m.content ?? ''));
    expect(historyOnly.join('\n').indexOf('m4-') >= 0).toBe(true);
    expect(historyOnly.join('\n').indexOf('m0-') >= 0).toBe(false);
  });

  test('oversized ambient is truncated with a note', async () => {
    let seenMessages: Array<{ role: string; content?: unknown }> = [];
    const response = await handleAiChat(
      post(
        { turnId: 'b-ambient', text: 'hi', ambient: { big: 'y'.repeat(10000) } },
        { Authorization: 'Bearer good' },
      ),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async (_model, input) => {
          seenMessages = input.messages as Array<{ role: string; content?: unknown }>;
          return { response: 'ok' };
        },
        callTabTool: async () => {
          throw new Error('no tools expected');
        },
      },
    );
    expect(response.status).toBe(200);
    const lastUser = seenMessages[seenMessages.length - 1];
    expect(String(lastUser?.content ?? '').indexOf('(truncated)') >= 0).toBe(true);
  });

  test('oversized area images are omitted with a note', async () => {
    let seenMessages: Array<{ role: string; content?: unknown }> = [];
    const big = 'data:image/png;base64,' + 'A'.repeat(1600000);
    const response = await handleAiChat(
      post(
        {
          turnId: 'b-image',
          text: 'look',
          areaReferences: [{ instruction: 'crop', image: { data: big } }],
        },
        { Authorization: 'Bearer good' },
      ),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async (_model, input) => {
          seenMessages = input.messages as Array<{ role: string; content?: unknown }>;
          return { response: 'seen' };
        },
        callTabTool: async () => {
          throw new Error('no tools expected');
        },
      },
    );
    const events = await readEvents(response);
    expect(events[events.length - 1]).toMatchObject({ type: 'chat.turn.end' });
    const lastUser = JSON.stringify(seenMessages[seenMessages.length - 1]?.content ?? null);
    expect(lastUser.indexOf('omitted') >= 0).toBe(true);
    expect(lastUser.indexOf('AAAAAAAAAA') >= 0).toBe(false);
  });

  test('turn.end reports cumulative usage across tool turns', async () => {
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'b-usage', text: 'go' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [{ id: 'c1', name: 'ograf_undo', arguments: {} }],
              usage: { prompt_tokens: 10, completion_tokens: 3 },
            };
          }
          return {
            response: 'done',
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          };
        },
        callTabTool: async () => ({ ok: true, result: {} }),
      },
    );
    const events = await readEvents(response);
    const end = events.find((event) => event.type === 'chat.turn.end') as unknown as {
      usage: { input: number; output: number };
    };
    expect(end.usage).toMatchObject({ input: 15, output: 5 });
  });

  test('proposal-mode results surface as chat.proposal and end the turn', async () => {
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'b-propose', text: 'rename it' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [
                {
                  id: 'c2',
                  name: 'ograf_apply_operations',
                  arguments: {
                    mode: 'propose',
                    expectedRevision: 0,
                    operations: [{ type: 'rename_layer', layerId: 'l1', name: 'X' }],
                    title: 'Rename title',
                  },
                },
              ],
            };
          }
          return { response: 'done' };
        },
        callTabTool: async () => ({
          ok: true,
          result: { mode: 'proposal', operationCount: 1, expectedRevision: 0, accepted: false },
        }),
      },
    );
    const events = await readEvents(response);
    const proposal = events.find((event) => event.type === 'chat.proposal') as unknown as {
      turnId: string;
      proposalId: string;
      proposal: { title: string; operations: unknown[]; operationCount: number };
    };
    expect(proposal.turnId).toBe('b-propose');
    expect(typeof proposal.proposalId).toBe('string');
    expect(proposal.proposal.title).toBe('Rename title');
    expect(proposal.proposal.operations).toHaveLength(1);
    expect(proposal.proposal.operationCount).toBe(1);
    // The turn ends after presenting: the human reviews in the editor next.
    expect(events[events.length - 1]).toMatchObject({ type: 'chat.turn.end', stopReason: 'done' });
  });

  test('reads OpenAI-style choices envelopes', async () => {
    expect(
      extractToolCalls({
        choices: [
          {
            message: {
              content: 'hi',
              tool_calls: [
                { id: 'o1', type: 'function', function: { name: 'ograf_undo', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    ).toEqual([{ id: 'o1', name: 'ograf_undo', args: {} }]);
    expect(extractAssistantText({ choices: [{ message: { content: 'yo' } }] })).toBe('yo');
  });
});

describe('coerceToolArgs (review fixes)', () => {
  test('passes plain objects through untouched', () => {
    const args = { sessionId: 'editor' };
    expect(coerceToolArgs(args, 'ograf_get_project')).toBe(args);
  });

  test('coerces strings, arrays and null to an empty object', () => {
    expect(coerceToolArgs('nope', 'ograf_get_project')).toEqual({});
    expect(coerceToolArgs(['x'], 'ograf_get_project')).toEqual({});
    expect(coerceToolArgs(null, 'ograf_get_project')).toEqual({});
    expect(coerceToolArgs(undefined, 'ograf_get_project')).toEqual({});
  });
});

describe('verifySouvToken schema handling (review fixes)', () => {
  const env = { SOUV_API: 'https://api.example.test' };
  const previousFetch = globalThis.fetch;

  test('accepts a token the Souv API confirms', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })) as typeof fetch;
    try {
      const { verifySouvToken } = await import('./auth');
      const hash = await verifySouvToken(env, 'good-token-verify-test');
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
      const { verifySouvToken } = await import('./auth');
      await expect(verifySouvToken(env, 'stale-backend-verify-test')).resolves.toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe('gatewayStubForCall tab routing (multi-tab)', () => {
  test('derives distinct stubs per tab and a stable stub per login', async () => {
    const { gatewayStubForCall } = await import('./aiChat');
    const seen: string[] = [];
    const env = {
      GATEWAY: {
        idFromName: (name: string) => name,
        get: (stub: string) => {
          seen.push(stub);
          return stub;
        },
      },
    };
    const a1 = await gatewayStubForCall(env as never, 'tok', 'tab-a');
    const a2 = await gatewayStubForCall(env as never, 'tok', 'tab-a');
    const b1 = await gatewayStubForCall(env as never, 'tok', 'tab-b');
    const c1 = await gatewayStubForCall(env as never, 'tok', null);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(a1).not.toBe(c1);
    expect(seen.length).toBe(4);
  });
});

describe('worker AI chat failure visibility (Fase 6B apply chain)', () => {
  test('operation types mirror the canonical zod union (no drift)', async () => {
    const { authoringOperationSchema } = await import('../../../packages/agent-tools/src/schemas');
    const union = authoringOperationSchema as unknown as {
      options?: Array<{ shape?: { type?: { value?: unknown } } }>;
    };
    const fromZod = [...new Set((union.options ?? []).map((option) => option.shape?.type?.value))]
      .filter((value): value is string => typeof value === 'string')
      .sort();
    expect(fromZod.length).toBeGreaterThan(0);
    expect([...MCP_OPERATION_TYPES].sort()).toEqual(fromZod);
  });

  test('apply tool definition exposes the operation vocabulary', () => {
    const apply = toWorkersAITools().find((tool) => tool.name === 'ograf_apply_operations');
    const items = (
      (apply?.parameters as { properties?: { operations?: { items?: unknown } } } | undefined)
        ?.properties?.operations as
        { items?: { properties?: { type?: { enum?: unknown } } } } | undefined
    )?.items;
    const enumValues = items?.properties?.type?.enum;
    expect(Array.isArray(enumValues)).toBe(true);
    expect(enumValues).toContain('set_project_metadata');
    expect(enumValues).toContain('set_composition');
  });

  test('chat.tool error events carry the tab error text', async () => {
    let rounds = 0;
    const response = await handleAiChat(
      post({ turnId: 'turn-9', text: 'Muda o fundo' }, { Authorization: 'Bearer good' }),
      ENV,
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return {
              response: '',
              tool_calls: [
                {
                  id: 'c1',
                  name: 'ograf_apply_operations',
                  arguments: JSON.stringify({ mode: 'apply', expectedRevision: 0, operations: [] }),
                },
              ],
            };
          }
          return { response: '' };
        },
        callTabTool: async () => ({
          ok: false,
          error: 'ograf_apply_operations: unknown operation type "set_background_color".',
        }),
      },
    );
    const events = await readEvents(response);
    expect(events).toContainEqual({
      type: 'chat.tool',
      turnId: 'turn-9',
      callId: 'c1',
      name: 'ograf_apply_operations',
      summary: 'ograf_apply_operations',
      status: 'error',
      error: expect.stringContaining('unknown operation type'),
    });
  });
});

describe('default tab wiring (Fase 6B id-as-name regression)', () => {
  interface SeenCall {
    stub: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }

  function gatewayEnv(seen: { stubs: string[]; calls: SeenCall[] }): Record<string, unknown> {
    return {
      SOUV_API: 'https://api.example.test',
      GATEWAY: {
        idFromName: (name: string) => name,
        get: (stub: string) => {
          seen.stubs.push(stub);
          return {
            fetch: async (input: Request) => {
              const headers: Record<string, string> = {};
              input.headers.forEach((value, key) => {
                headers[key] = value;
              });
              seen.calls.push({ stub, url: input.url, headers, body: await input.json() });
              return Response.json({ ok: true, result: { mode: 'apply', applied: true } });
            },
          };
        },
      },
    };
  }

  function openAiToolCalls(calls: Array<{ id: string; name: string; args: unknown }>) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  test('OpenAI tool_calls with random ids resolve by function.name, not id/token', async () => {
    const seen: { stubs: string[]; calls: SeenCall[] } = { stubs: [], calls: [] };
    let rounds = 0;
    const response = await handleAiChat(
      post(
        { turnId: 'turn-x', sessionId: 'editor:abc', tabId: 'tab-9', text: 'Muda o fundo' },
        { Authorization: 'Bearer tok-test' },
      ),
      gatewayEnv(seen),
      {
        verifyToken: async () => 'hash',
        runModel: async () => {
          rounds += 1;
          if (rounds === 1) {
            return openAiToolCalls([
              { id: '002garjn2xyz', name: 'ograf_get_project', args: {} },
              {
                id: 'call_77qz',
                name: 'ograf_validate_project',
                args: { sections: ['layers'] },
              },
            ]);
          }
          return { response: 'Feito', usage: { prompt_tokens: 2, completion_tokens: 1 } };
        },
      },
    );
    expect(response.status).toBe(200);
    const events = await readEvents(response);
    // Both calls fan out with real tool names (never the call id/token)...
    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[0]?.body).toMatchObject({ name: 'ograf_get_project', args: {} });
    expect(seen.calls[1]?.body).toMatchObject({
      name: 'ograf_validate_project',
      args: { sections: ['layers'] },
    });
    // ...authenticated as the login token, through the origin-tab stub...
    for (const call of seen.calls) {
      expect(call.headers['authorization']).toBe('Bearer tok-test');
      expect(call.url).toContain('/internal/tool-call');
      expect(call.stub).toBe(seen.stubs[0]);
    }
    // ...and reported ok (no `Unknown WebMCP tool` anywhere).
    const toolEvents = events.filter((event) => event.type === 'chat.tool');
    expect(toolEvents.filter((event) => event.status === 'ok')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('Unknown WebMCP tool');
    expect(events.at(-1)).toMatchObject({ type: 'chat.turn.end', stopReason: 'done' });
  });

  test('origin-tab stubs stay isolated per tabId on the real path', async () => {
    const seen: { stubs: string[]; calls: SeenCall[] } = { stubs: [], calls: [] };
    const run = (tabId: string) => {
      let rounds = 0;
      return handleAiChat(
        post({ turnId: 't-' + tabId, text: 'oi', tabId }, { Authorization: 'Bearer tok-test' }),
        gatewayEnv(seen),
        {
          verifyToken: async () => 'hash',
          runModel: async () => {
            rounds += 1;
            if (rounds === 1) {
              return openAiToolCalls([{ id: 'x1', name: 'ograf_get_project', args: {} }]);
            }
            return { response: 'ok', usage: {} };
          },
        },
      );
    };
    const first = await run('tab-a');
    const second = await run('tab-b');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Drain both SSE streams: tool calls fan out from the stream's async
    // start(), which only settles once the body is consumed.
    const firstEvents = await readEvents(first);
    const secondEvents = await readEvents(second);
    expect(firstEvents.at(-1)).toMatchObject({ type: 'chat.turn.end', stopReason: 'done' });
    expect(secondEvents.at(-1)).toMatchObject({ type: 'chat.turn.end', stopReason: 'done' });
    expect(JSON.stringify([...firstEvents, ...secondEvents])).not.toContain('Unknown WebMCP tool');
    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[0]?.body).toMatchObject({ name: 'ograf_get_project' });
    expect(seen.calls[1]?.body).toMatchObject({ name: 'ograf_get_project' });
    expect(seen.calls[0]?.stub).not.toBe(seen.calls[1]?.stub);
  });
});
