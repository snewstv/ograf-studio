/**
 * MCP/WebMCP tool catalog shared by the gateway (worker) and the editor tab.
 * Dependency-free on purpose: the editor test suite imports this file by
 * relative path and asserts the names match `WEBMCP_TOOL_NAMES`, so the two
 * surfaces cannot drift apart silently.
 *
 * Schemas mirror `providerToolDefinition()` output shape (JSON Schema draft-7
 * style, `{ type: 'object', properties, required? }`) for the parameters the
 * gateway actually forwards. Full canonical schemas live in
 * `packages/agent-tools`; the tab executes the canonical handlers.
 */
export const MCP_GATEWAY_NAME = 'ograf-studio-gateway';
export const MCP_GATEWAY_VERSION = '0.22.0';

/** Must stay identical to `WEBMCP_TOOL_NAMES` in `apps/editor/src/cloud/webmcpHost.ts`. */
export const MCP_TOOL_NAMES = [
  'ograf_get_capabilities',
  'ograf_query_scene',
  'ograf_inspect_scene',
  'ograf_get_project',
  'ograf_get_timeline',
  'ograf_sample_tracks',
  'ograf_apply_operations',
  'ograf_capture',
  'ograf_render_strip',
  'ograf_measure_text',
  'ograf_review_design',
  'ograf_validate_project',
  'ograf_undo',
  'ograf_redo',
] as const;

export type MCPToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_TOOL_DESCRIPTIONS: Record<MCPToolName, string> = {
  ograf_get_capabilities: 'Gateway and session capabilities (per-tab, login-gated cloud only).',
  ograf_query_scene: 'Semantic scene query over the live editor project.',
  ograf_inspect_scene: 'Detailed inspection of layers, tracks and bindings.',
  ograf_get_project: 'Project snapshot (honors include/tracks projection).',
  ograf_get_timeline: 'Compositions and lifecycle summary.',
  ograf_sample_tracks: 'Sampled animation track values.',
  ograf_apply_operations:
    'Atomic apply, dry-run, rendered preview, or Accept/Reject proposal. Mutations run in the connected editor tab with revision checks.',
  ograf_capture: 'Rendered PNG capture of the live tab (foreground tab required).',
  ograf_render_strip: 'Multi-frame contact strip from the live tab.',
  ograf_measure_text: 'Browser text measurement in the live tab.',
  ograf_review_design: 'Deterministic design QA review.',
  ograf_validate_project: 'Project validation (migrate + validate).',
  ograf_undo: 'Undo in the connected editor tab.',
  ograf_redo: 'Redo in the connected editor tab.',
};

const sessionId = {
  sessionId: { type: 'string', description: 'Authoring session id.', default: 'editor' },
};

export const MCP_TOOL_SCHEMAS: Record<MCPToolName, Record<string, unknown>> = {
  ograf_get_capabilities: {
    type: 'object',
    properties: { sections: { type: 'array', items: { type: 'string' } } },
  },
  ograf_query_scene: {
    type: 'object',
    properties: { ...sessionId, query: { type: 'string' } },
  },
  ograf_inspect_scene: {
    type: 'object',
    properties: { ...sessionId, layerId: { type: 'string' } },
  },
  ograf_get_project: {
    type: 'object',
    properties: {
      ...sessionId,
      include: { type: 'array', items: { type: 'string' } },
      tracks: { type: 'string', enum: ['none', 'animated-only', 'full'] },
    },
  },
  ograf_get_timeline: { type: 'object', properties: { ...sessionId } },
  ograf_sample_tracks: {
    type: 'object',
    properties: { ...sessionId, layerId: { type: 'string' }, frames: { type: 'array' } },
  },
  ograf_apply_operations: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['apply', 'dry-run', 'preview', 'propose'], default: 'apply' },
      sessionId: { type: 'string', default: 'editor' },
      expectedRevision: { type: 'integer', minimum: 0 },
      operations: { type: 'array', minItems: 1 },
      reason: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['expectedRevision', 'operations'],
  },
  ograf_capture: {
    type: 'object',
    properties: {
      ...sessionId,
      compositionId: { type: 'string' },
      frame: { type: 'integer', minimum: 0 },
      maxDimension: { type: 'integer', minimum: 64, maximum: 4096 },
    },
  },
  ograf_render_strip: {
    type: 'object',
    properties: { ...sessionId, compositionId: { type: 'string' }, frames: { type: 'array' } },
  },
  ograf_measure_text: {
    type: 'object',
    properties: {
      ...sessionId,
      layerId: { type: 'string' },
      text: { type: 'string' },
      frame: { type: 'integer', minimum: 0 },
    },
  },
  ograf_review_design: { type: 'object', properties: { ...sessionId } },
  ograf_validate_project: { type: 'object', properties: { ...sessionId } },
  ograf_undo: { type: 'object', properties: {} },
  ograf_redo: { type: 'object', properties: {} },
};
