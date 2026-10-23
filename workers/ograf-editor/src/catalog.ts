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

/** Must stay identical to the operation `type` literals in `authoringOperationSchema` (packages/agent-tools/src/schemas.ts). Enforced by the anti-drift test in `aiChat.test.ts`. */
export const MCP_OPERATION_TYPES: string[] = [
  'add_asset',
  'add_canvas_guide',
  'add_custom_action',
  'add_data_field',
  'add_effect',
  'add_layer',
  'add_lifecycle_step',
  'apply_style_pack',
  'bind_design_token',
  'create_lower_third',
  'create_repeater',
  'create_runtime_collection',
  'create_timeline_group',
  'duplicate_effect',
  'duplicate_group',
  'edit_path',
  'group_layers',
  'instantiate_component',
  'move_lifecycle_keyframe',
  'move_property_key',
  'refresh_component_instances',
  'remove_asset',
  'remove_canvas_guide',
  'remove_component',
  'remove_custom_action',
  'remove_data_field',
  'remove_design_token',
  'remove_effect',
  'remove_layer',
  'remove_layer_loop',
  'remove_lifecycle_step',
  'remove_property_key',
  'remove_runtime_collection',
  'remove_style_pack',
  'remove_tiling_pattern',
  'rename_component',
  'rename_layer',
  'rename_lifecycle_keyframe',
  'rename_timeline_group',
  'reorder_effects',
  'reorder_layers',
  'save_component',
  'set_composition',
  'set_composition_layout',
  'set_design_system_name',
  'set_layer_binding',
  'set_layer_bindings',
  'set_layer_flags',
  'set_layer_layout',
  'set_layer_lighting',
  'set_layer_loop',
  'set_layer_mask',
  'set_layer_semantics',
  'set_loop_property_track',
  'set_project_metadata',
  'set_property_key',
  'set_property_key_easing',
  'set_property_track',
  'set_tiling_pattern',
  'set_timeline_group_color',
  'set_transition',
  'stagger_property_track',
  'unbind_design_token',
  'ungroup_layers',
  'ungroup_timeline_group',
  'update_asset',
  'update_canvas_guide',
  'update_component_from_layers',
  'update_custom_action',
  'update_data_field',
  'update_effect',
  'update_effects',
  'update_element',
  'update_runtime_collection',
  'update_transform',
  'upsert_design_token',
];

export type MCPToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_TOOL_DESCRIPTIONS: Record<MCPToolName, string> = {
  ograf_get_capabilities: 'Gateway and session capabilities (per-tab, login-gated cloud only).',
  ograf_query_scene: 'Semantic scene query over the live editor project.',
  ograf_inspect_scene: 'Detailed inspection of layers, tracks and bindings.',
  ograf_get_project: 'Project snapshot (honors include/tracks projection).',
  ograf_get_timeline: 'Compositions and lifecycle summary.',
  ograf_sample_tracks: 'Sampled animation track values.',
  ograf_apply_operations:
    'Atomic apply, dry-run, rendered preview, or Accept/Reject proposal. Mutations run in the connected editor tab with revision checks. Each operation needs a valid `type` from the type enum; never invent operation names. Layer-editing operations always need their nested objects: update_element/update_transform/update_effect/update_effects/set_layer_semantics require a `patch` object with the element fields, plus a layer selector (layerId, or layerName to resolve by name). A bare {"type":"update_element"} never works. Example card recolor: {"type":"update_element","layerId":"<id from ograf_inspect_scene>","patch":{"fill":"#00ff00"}}. Adding new content uses creation types, never updates: add_layer with a `kind` creates a layer; text layers carry their visible string in the `content` field. Example title: {"type":"add_layer","kind":"text","name":"Titulo","element":{"content":"NOVO TITULO"}}. Shape layers use the full kind names (rectangle, ellipse, text, image, path, pattern, image-sequence, lottie, shader) — never abbreviations like rect. Example red box: {"type":"add_layer","kind":"rectangle","name":"Caixa","transform":{"x":100,"y":100,"width":200,"height":200},"element":{"fill":"#ff0000"}}.',
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
      // Operation vocabulary for the model: every item needs a valid type
      // from MCP_OPERATION_TYPES (never invent operation names).
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          description:
            'One authoring operation. `type` is required; layer-editing operations (update_element, update_transform, update_effect, update_effects, set_layer_semantics) also require a `patch` object with the element fields and a layer selector (layerId or layerName).',
          properties: { type: { type: 'string', enum: MCP_OPERATION_TYPES } },
          required: ['type'],
        },
      },
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
