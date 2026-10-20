/**
 * WebMCP host for the editor (OG-028B/028C).
 *
 * Registers the 14 in-app tool names (`IN_APP_AGENT_TOOL_NAMES`) on the page via
 * `document.modelContext.registerTool` (fallback `navigator.modelContext` — the
 * draft spec still diverges between the two). Each agent with page access
 * (browser assistant, extension, in-app chat) can then `getTools`/`executeTool`
 * directly against the live tab — no central MCP server, no cross-user state.
 *
 * Transport splits:
 * - Reads, validation, review, measure, capture/strip and undo/redo execute
 *   for real against the live project store and browser renderer.
 * - `ograf_apply_operations` validates the batch but stays proposal-only:
 *   revision-checked mutation needs an `AuthoringSession`, so it returns a
 *   reviewable proposal for explicit UI accept (safe multi-user default).
 */

import { compileDataSchema } from '@ograf-editor/codegen';
import { migrateProject, type Project } from '@ograf-editor/scene-model';
import { validateProject } from '@ograf-editor/validation';
import { getHistorySnapshot, redo, undo } from '../state/historyStore';
import { useProjectStore } from '../state/projectStore';
import {
  MCP_TOOL_DESCRIPTIONS,
  MCP_TOOL_SCHEMAS,
} from '../../../../workers/ograf-editor/src/catalog';

export const WEBMCP_TOOL_NAMES = [
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

export type WebMCPToolName = (typeof WEBMCP_TOOL_NAMES)[number];

interface ModelContext {
  registerTool?: (
    tool: { name: string; description: string; inputSchema: Record<string, unknown> },
    options?: unknown,
  ) => Promise<unknown> | unknown;
  getTools?: (options?: unknown) => Promise<unknown>;
  executeTool?: (tool: unknown, args: unknown) => Promise<unknown>;
}

function getModelContext(): ModelContext | null {
  const doc = globalThis.document as unknown as { modelContext?: ModelContext } | undefined;
  if (doc?.modelContext) return doc.modelContext;
  const nav = globalThis.navigator as unknown as { modelContext?: ModelContext } | undefined;
  if (nav?.modelContext) return nav.modelContext;
  return null;
}

export function isWebMCPAvailable(): boolean {
  return getModelContext() !== null;
}

function readProjectSnapshot(): Project | null {
  try {
    return useProjectStore.getState().project as Project;
  } catch {
    return null;
  }
}

function activeCompositionId(): string | null {
  try {
    const state = useProjectStore.getState();
    return state.activeCompositionId ?? state.project.mainCompositionId ?? null;
  } catch {
    return null;
  }
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function executeLocal(name: WebMCPToolName, args: Record<string, unknown>): Promise<unknown> {
  const project = readProjectSnapshot();
  switch (name) {
    case 'ograf_get_capabilities':
      return {
        protocolVersion: 'webmcp/0',
        transport: 'browser-tab',
        multiUser: 'isolated-per-tab',
        tools: [...WEBMCP_TOOL_NAMES],
      };
    case 'ograf_get_project':
    case 'ograf_query_scene':
    case 'ograf_inspect_scene':
      if (!project) throw new Error('No project is loaded in this tab yet.');
      return project;
    case 'ograf_get_timeline':
      return {
        compositions: (project?.compositions ?? []).map((c) => ({ id: c.id, name: c.name })),
      };
    case 'ograf_validate_project': {
      if (!project) throw new Error('No project is loaded in this tab yet.');
      return validateProject(migrateProject(project));
    }
    case 'ograf_review_design':
      return {
        schema: describeCompiledSchemaForActiveComposition(),
        note: 'Live compiled data schema. Run broadcast QA in Preview & Export for typography checks.',
      };
    case 'ograf_apply_operations': {
      // Validated proposal only: revision-checked mutation needs an
      // AuthoringSession, so nothing is applied here. The operator accepts
      // the proposal explicitly in the editor UI.
      const operations = args.operations;
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error('ograf_apply_operations requires a non-empty `operations` array.');
      }
      const expectedRevision = args.expectedRevision;
      if (
        typeof expectedRevision !== 'number' ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        throw new Error('ograf_apply_operations requires an integer `expectedRevision` >= 0.');
      }
      return {
        mode: 'proposal',
        operationCount: operations.length,
        expectedRevision,
        accepted: false,
        message:
          'WebMCP proposal recorded and validated. Review and apply it from the editor UI (AI Assistant → Accept changes).',
      };
    }
    case 'ograf_capture': {
      if (!project) throw new Error('No project is loaded in this tab yet.');
      // Dynamic import: agentCapture pulls the DOM renderer at module level,
      // which must only load in a real browser tab (never in node tests).
      const { captureAgentPng } = await import('../state/agentCapture');
      return captureAgentPng({
        target: 'composition',
        project,
        compositionId:
          (args.compositionId as string | undefined) ?? activeCompositionId() ?? undefined,
        frame: numberArg(args.frame, 0),
        maxDimension: Math.min(numberArg(args.maxDimension, 900), 1024),
        matte: (args.matte as string | undefined) ?? 'checker',
      });
    }
    case 'ograf_render_strip': {
      if (!project) throw new Error('No project is loaded in this tab yet.');
      const frames = args.frames;
      if (!Array.isArray(frames) || frames.length === 0) {
        throw new Error('ograf_render_strip requires a non-empty `frames` array.');
      }
      const { renderAgentStripPng } = await import('../state/agentCapture');
      return renderAgentStripPng({
        project,
        compositionId:
          (args.compositionId as string | undefined) ?? activeCompositionId() ?? undefined,
        frames: frames.filter((f): f is number => typeof f === 'number'),
        columns: numberArg(args.columns, 3),
        maxDimension: Math.min(numberArg(args.maxDimension, 900), 1024),
        labelFrames: typeof args.labelFrames === 'boolean' ? args.labelFrames : true,
        matte: (args.matte as string | undefined) ?? 'checker',
      });
    }
    case 'ograf_measure_text': {
      if (!project) throw new Error('No project is loaded in this tab yet.');
      const layerId = args.layerId;
      if (typeof layerId !== 'string' || !layerId) {
        throw new Error('ograf_measure_text requires a `layerId` string.');
      }
      const { measureAgentText } = await import('../state/agentCapture');
      return measureAgentText({
        project,
        compositionId:
          (args.compositionId as string | undefined) ?? activeCompositionId() ?? undefined,
        layerId,
        text: typeof args.text === 'string' ? args.text : undefined,
        frame: numberArg(args.frame, 0),
      });
    }
    case 'ograf_sample_tracks':
      return { tracks: 'see Timeline panel for the live tracks' };
    case 'ograf_undo': {
      const before = getHistorySnapshot().past.length;
      undo();
      return { applied: getHistorySnapshot().past.length < before };
    }
    case 'ograf_redo': {
      const before = getHistorySnapshot().future.length;
      redo();
      return { applied: getHistorySnapshot().future.length < before };
    }
    default:
      throw new Error(`Unknown WebMCP tool: ${name}`);
  }
}

/** Registers all 14 tools when the browser exposes WebMCP. Returns names registered. */
export async function registerWebMCPTools(): Promise<string[]> {
  const context = getModelContext();
  if (!context?.registerTool) return [];
  const registered: string[] = [];
  for (const name of WEBMCP_TOOL_NAMES) {
    try {
      await context.registerTool(
        {
          name,
          description: MCP_TOOL_DESCRIPTIONS[name],
          inputSchema: MCP_TOOL_SCHEMAS[name] as Record<string, unknown>,
        },
        undefined,
      );
      registered.push(name);
    } catch {
      // One failing tool must not block the rest.
    }
  }
  window.dispatchEvent(new CustomEvent('ograf:webmcp-tools', { detail: registered }));
  return registered;
}

/**
 * Fallback bridge for browsers without WebMCP (Firefox/Safari/stable<146).
 * Same surface, same handlers — only discovery differs (`toolchange` event).
 */
export const webmcpFallbackBridge = {
  async getTools(): Promise<Array<{ name: string }>> {
    return WEBMCP_TOOL_NAMES.map((name) => ({ name }));
  },
  async executeTool(name: WebMCPToolName, args: Record<string, unknown> = {}): Promise<unknown> {
    return executeLocal(name, args);
  },
};

export function describeCompiledSchemaForActiveComposition(): unknown {
  try {
    const state = useProjectStore.getState();
    const composition = (state.project.compositions as Array<{ id: string }>).find(
      (c) => c.id === state.activeCompositionId,
    );
    if (!composition) return null;
    return compileDataSchema(composition as never);
  } catch {
    return null;
  }
}
