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
import {
  computeKeyframeFrames,
  getLayerAnimatableProperties,
  getLayerPropertyValueAtFrame,
  getResolvedLayerAnimationTracks,
  migrateProject,
  type Layer,
  type Project,
} from '@ograf-editor/scene-model';
import { validateProject } from '@ograf-editor/validation';
import { applyRemoteProjectUpdate, getHistorySnapshot, redo, undo } from '../state/historyStore';
import { applyAuthoringOperations } from '@ograf-editor/authoring-core';
import { normalizeOperationSelectors } from '@ograf-editor/agent-tools/normalize-operations';
import { useProjectStore } from '../state/projectStore';
import {
  MCP_OPERATION_TYPES,
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

/** Upper bound for sampled frames per `ograf_sample_tracks` call. */
const MAX_SAMPLE_FRAMES = 32;

function roundSample(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface SampledLayerTracks {
  layerId: string;
  name: string;
  kind: string;
  samples: Record<string, number[]>;
  keyframes: Record<string, Array<{ frame: number; value: number; easing: string }>>;
}

/**
 * Real track sampling for `ograf_sample_tracks` (gap fechado Fase 6B):
 * interpolated values per requested frame plus the authored keyframes,
 * resolved through the same engine the renderer uses. Never a pointer stub.
 */
export function sampleLayerTracks(layer: Layer, frames: number[]): SampledLayerTracks {
  const tracks = getResolvedLayerAnimationTracks(layer);
  const samples: Record<string, number[]> = {};
  const keyframes: Record<string, Array<{ frame: number; value: number; easing: string }>> = {};
  for (const property of getLayerAnimatableProperties(layer)) {
    samples[property] = frames.map((frame) =>
      roundSample(getLayerPropertyValueAtFrame(layer, property, frame)),
    );
    keyframes[property] = (tracks[property] ?? []).map((keyframe) => ({
      frame: keyframe.frame,
      value: roundSample(keyframe.value),
      easing: keyframe.easing,
    }));
  }
  return { layerId: layer.id, name: layer.name, kind: layer.element.type, samples, keyframes };
}

/**
 * Rejects hallucinated operation types with the valid vocabulary before
 * anything else runs. The applier ignores unknown types silently, which
 * used to surface as a fake applied success with zero changes; the worker
 * feeds this error back to the model so it can retry within the turn.
 * Shared by the tab tool path and the in-tab proposal preview.
 */
export function assertKnownOperationTypes(operations: unknown): void {
  if (!Array.isArray(operations)) {
    throw new Error('ograf_apply_operations requires an `operations` array.');
  }
  const unknownOperation = operations.find(
    (operation) =>
      !operation ||
      typeof operation !== 'object' ||
      !MCP_OPERATION_TYPES.includes((operation as { type?: unknown }).type as string),
  );
  if (unknownOperation !== undefined) {
    const seen =
      unknownOperation !== null && typeof unknownOperation === 'object'
        ? (unknownOperation as { type?: unknown }).type
        : unknownOperation;
    throw new Error(
      'ograf_apply_operations: unknown operation type ' +
        JSON.stringify(seen) +
        '. Valid types: ' +
        MCP_OPERATION_TYPES.join(', '),
    );
  }
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
      // Fail loud on hallucinated operation types: the applier ignores
      // unknown types silently, which used to surface as a fake `applied`
      // success with zero changes. The worker feeds this error back to the
      // model so it can retry with a listed type.
      assertKnownOperationTypes(operations);
      const expectedRevision = args.expectedRevision;
      if (
        typeof expectedRevision !== 'number' ||
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        throw new Error('ograf_apply_operations requires an integer `expectedRevision` >= 0.');
      }
      const mode = typeof args.mode === 'string' ? args.mode : 'apply';
      if (!project) throw new Error('No project is loaded in this tab yet.');
      // Validate the batch even when proposal-only: the worker relies on the
      // tool error to fix arguments within the turn. Without this, a broken
      // batch (e.g. update_element without patch) would surface as a
      // reviewable proposal and die later in the preview with no retry.
      normalizeOperationSelectors(project, operations);
      if (mode !== 'apply') {
        // propose/dry-run/preview stay proposal-only for explicit human
        // Accept: revision-checked mutation needs an AuthoringSession.
        return {
          mode: 'proposal',
          requestedMode: mode,
          operationCount: operations.length,
          expectedRevision,
          accepted: false,
          message:
            'WebMCP proposal recorded and validated. Review and apply it from the editor UI (AI Assistant → Accept changes).',
        };
      }
      // mode=apply (OG-093): validate, then mutate the live project in this
      // tab so the change is visible during/after the turn. History-aware
      // (undoable via Edit → History); validation and apply errors fail loud.
      const typed = normalizeOperationSelectors(project, operations);
      const applied = applyAuthoringOperations(project, typed);
      const reason = typeof args.reason === 'string' && args.reason ? args.reason : 'AI Assistant';
      applyRemoteProjectUpdate(applied.project, {
        source: 'agent',
        reason,
        summary: {
          operationCount: applied.summary.operationCount,
          operationTypes: applied.summary.operationTypes,
        },
      });
      return {
        mode: 'apply',
        applied: true,
        operationCount: applied.summary.operationCount,
        operationTypes: applied.summary.operationTypes,
        expectedRevision,
        warnings: applied.summary.warnings,
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
    case 'ograf_sample_tracks': {
      if (!project) throw new Error('No project is loaded in this tab yet.');
      const composition =
        project.compositions.find((candidate) => candidate.id === activeCompositionId()) ??
        project.compositions.find((candidate) => candidate.id === project.mainCompositionId);
      if (!composition) throw new Error('No composition is loaded in this tab yet.');
      const requested = Array.isArray(args.frames)
        ? args.frames.filter(
            (frame): frame is number => typeof frame === 'number' && Number.isFinite(frame),
          )
        : [];
      const sourceFrames =
        requested.length > 0
          ? requested
          : computeKeyframeFrames(composition).map((item) => item.frame);
      const frames = sourceFrames
        .map((frame) => Math.max(0, Math.round(frame)))
        .slice(0, MAX_SAMPLE_FRAMES);
      if (frames.length === 0) {
        throw new Error('ograf_sample_tracks requires a non-empty `frames` array.');
      }
      const layerId = typeof args.layerId === 'string' && args.layerId ? args.layerId : undefined;
      const layers = layerId
        ? composition.layers.filter((layer) => layer.id === layerId)
        : [...composition.layers];
      if (layerId && layers.length === 0) throw new Error(`Layer not found: ${layerId}`);
      return {
        compositionId: composition.id,
        frames,
        layers: layers.map((layer) => sampleLayerTracks(layer, frames)),
      };
    }
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
