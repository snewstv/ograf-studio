import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '../../../../workers/ograf-editor/src/catalog';
import { WEBMCP_TOOL_NAMES } from './webmcpHost';

/**
 * Anti-drift guard: the worker gateway catalog and the tab WebMCP surface
 * must expose exactly the same 14 tools (OG-028G).
 */
describe('gateway catalog parity', () => {
  it('matches WEBMCP_TOOL_NAMES exactly', () => {
    expect([...MCP_TOOL_NAMES]).toEqual([...WEBMCP_TOOL_NAMES]);
    expect(MCP_TOOL_NAMES).toHaveLength(14);
  });
});
