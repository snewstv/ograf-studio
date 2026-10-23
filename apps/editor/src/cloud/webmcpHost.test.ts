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

  // OG-093: propose/dry-run/preview stay proposal-only for human Accept;
  // default/apply now validates and mutates the live tab (webmcpApply.test.ts).
  it('holds propose-mode mutations as validated reviewable proposals', async () => {
    const result = (await webmcpFallbackBridge.executeTool('ograf_apply_operations', {
      operations: [{ type: 'set_project_metadata', name: 'Proposed' }],
      expectedRevision: 3,
      mode: 'propose',
    })) as { mode: string; accepted: boolean; operationCount: number; expectedRevision: number };
    expect(result.mode).toBe('proposal');
    expect(result.accepted).toBe(false);
    expect(result.operationCount).toBe(1);
    expect(result.expectedRevision).toBe(3);
  });

  it('rejects malformed apply batches before proposing', async () => {
    await expect(
      webmcpFallbackBridge.executeTool('ograf_apply_operations', {
        operations: [{ type: 'set_project_metadata', name: 'x' }],
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
    // Empty history in tests: nothing moves, so applied is false. A tab
    // with real edits reports true. historyStore uses global timers, so no
    // `window` stub is needed in node.
    await expect(webmcpFallbackBridge.executeTool('ograf_undo', {})).resolves.toMatchObject({
      applied: false,
    });
    await expect(webmcpFallbackBridge.executeTool('ograf_redo', {})).resolves.toMatchObject({
      applied: false,
    });
  });
});
