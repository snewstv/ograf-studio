import { describe, expect, test } from 'bun:test';
import { MCP_TOOL_NAMES } from './catalog';
import { respondToMessage } from './mcpRouter';

const callTab = async (name: string, args: Record<string, unknown>) => ({ echo: name, args });

describe('mcp router (OG-028G)', () => {
  test('initialize negotiates a known version, falls back to latest', async () => {
    const known = (await respondToMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { callTab },
    )) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(known.result.protocolVersion).toBe('2025-06-18');
    expect(known.result.serverInfo.name).toBe('ograf-studio-gateway');
    const fallback = (await respondToMessage(
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } },
      { callTab },
    )) as { result: { protocolVersion: string } };
    expect(fallback.result.protocolVersion).toBe('2025-11-25');
  });

  test('tools/list exposes the 14 catalog tools', async () => {
    const reply = (await respondToMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { callTab },
    )) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    expect(reply.result.tools.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
    const apply = reply.result.tools.find((t) => t.name === 'ograf_apply_operations');
    expect(apply?.inputSchema).toMatchObject({ required: ['expectedRevision', 'operations'] });
  });

  test('capabilities answers inline; other calls route to the tab', async () => {
    const caps = (await respondToMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'ograf_get_capabilities', arguments: {} },
      },
      {
        callTab: () => {
          throw new Error('must not reach the tab');
        },
      },
    )) as { result: { content: Array<{ text: string }> } };
    expect(caps.result.content[0]?.text).toContain('mcp-gateway');
    const routed = (await respondToMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'ograf_get_timeline', arguments: {} },
      },
      { callTab },
    )) as { result: { content: Array<{ text: string }> } };
    expect(routed.result.content[0]?.text).toContain('ograf_get_timeline');
  });

  test('unknown tool, unknown method and invalid envelopes error cleanly', async () => {
    const unknownTool = (await respondToMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      { callTab },
    )) as { error: { code: number } };
    expect(unknownTool.error.code).toBe(-32602);
    const unknownMethod = (await respondToMessage(
      { jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} },
      { callTab },
    )) as { error: { code: number } };
    expect(unknownMethod.error.code).toBe(-32601);
    const invalid = (await respondToMessage({ nope: true }, { callTab })) as {
      error: { code: number };
    };
    expect(invalid.error.code).toBe(-32600);
    const notification = await respondToMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { callTab },
    );
    expect(notification).toBeUndefined();
  });

  test('tab failures map to -32001 (no tab) or -32603', async () => {
    const noTab = (await respondToMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'ograf_undo', arguments: {} },
      },
      {
        callTab: () => {
          throw new Error(
            'No editor tab is connected for this login. Open the OGraf editor, log in with the same Souv account, and keep the tab focused.',
          );
        },
      },
    )) as { error: { code: number } };
    expect(noTab.error.code).toBe(-32001);
    const boom = (await respondToMessage(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'ograf_undo', arguments: {} },
      },
      {
        callTab: () => {
          throw new Error('boom');
        },
      },
    )) as { error: { code: number } };
    expect(boom.error.code).toBe(-32603);
  });
});
