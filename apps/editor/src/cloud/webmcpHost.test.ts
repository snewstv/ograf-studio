import { describe, expect, it } from 'vitest';
import { WEBMCP_TOOL_NAMES, webmcpFallbackBridge } from './webmcpHost';

describe('webmcp fallback bridge (OG-028C/028I)', () => {
  it('exposes the 14 in-app tool names', async () => {
    const tools = await webmcpFallbackBridge.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([...WEBMCP_TOOL_NAMES]);
    expect(WEBMCP_TOOL_NAMES).toHaveLength(14);
  });

  it('answers capabilities without a server roundtrip', async () => {
    const result = (await webmcpFallbackBridge.executeTool('ograf_get_capabilities', {})) as {
      transport: string;
      tools: string[];
    };
    expect(result.transport).toBe('browser-tab');
    expect(result.tools).toContain('ograf_apply_operations');
  });

  it('holds mutations as validated reviewable proposals', async () => {
    const result = (await webmcpFallbackBridge.executeTool('ograf_apply_operations', {
      operations: [{ type: 'noop' }],
      expectedRevision: 3,
    })) as { mode: string; accepted: boolean; operationCount: number; expectedRevision: number };
    expect(result.mode).toBe('proposal');
    expect(result.accepted).toBe(false);
    expect(result.operationCount).toBe(1);
    expect(result.expectedRevision).toBe(3);
  });

  it('rejects malformed apply batches before proposing', async () => {
    await expect(
      webmcpFallbackBridge.executeTool('ograf_apply_operations', {
        operations: [{ type: 'noop' }],
      }),
    ).rejects.toThrow(/expectedRevision/);
    await expect(
      webmcpFallbackBridge.executeTool('ograf_apply_operations', {
        operations: [],
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it('undo/redo report whether history actually moved', async () => {
    // historyStore drives timers through `window`: stub the two functions it
    // uses so the empty-history path runs in node. A real browser tab has them.
    const g = globalThis as unknown as Record<string, unknown>;
    const previousWindow = g.window;
    g.window = {
      clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    };
    try {
      // Empty history in tests: nothing moves, so applied is false. A tab
      // with real edits reports true.
      await expect(webmcpFallbackBridge.executeTool('ograf_undo', {})).resolves.toMatchObject({
        applied: false,
      });
      await expect(webmcpFallbackBridge.executeTool('ograf_redo', {})).resolves.toMatchObject({
        applied: false,
      });
    } finally {
      if (previousWindow === undefined) delete g.window;
      else g.window = previousWindow;
    }
  });
});
