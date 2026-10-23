import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '../state/projectStore';
import { getHistorySnapshot, undo } from '../state/historyStore';
import { assertKnownOperationTypes, webmcpFallbackBridge, type WebMCPToolName } from './webmcpHost';

async function applyMode(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await webmcpFallbackBridge.executeTool(
    'ograf_apply_operations' as WebMCPToolName,
    args,
  )) as Record<string, unknown>;
}

describe('webmcp apply-direct (OG-093)', () => {
  beforeEach(() => {
    // Revert any applied steps so each test starts from a clean project.
    // (Redo is left alone: reapplying it would dirty the project again.)
    while (getHistorySnapshot().canUndo) undo();
  });

  it('mode=apply validates and mutates the live project, undo reverts', async () => {
    const before = useProjectStore.getState().project.name;
    const result = await applyMode({
      operations: [{ type: 'set_project_metadata', name: 'Via worker' }],
      expectedRevision: 0,
      mode: 'apply',
    });
    expect(result).toMatchObject({ mode: 'apply', applied: true, operationCount: 1 });
    expect(result.operationTypes).toEqual(['set_project_metadata']);
    expect(useProjectStore.getState().project.name).toBe('Via worker');
    expect(getHistorySnapshot().canUndo).toBe(true);
    undo();
    expect(useProjectStore.getState().project.name).toBe(before);
  });

  it('propose/dry-run/preview stay proposal-only and change nothing', async () => {
    const before = useProjectStore.getState().project;
    for (const mode of ['propose', 'dry-run', 'preview']) {
      const result = await applyMode({
        operations: [{ type: 'set_project_metadata', name: 'Must not land ' + mode }],
        expectedRevision: 0,
        mode,
      });
      expect(result).toMatchObject({ mode: 'proposal', accepted: false });
    }
    expect(useProjectStore.getState().project).toBe(before);
  });

  it('rejects empty batches, bad revisions and unknown operations', async () => {
    await expect(applyMode({ operations: [], expectedRevision: 0 })).rejects.toThrow('non-empty');
    await expect(
      applyMode({
        operations: [{ type: 'set_project_metadata', name: 'x' }],
        expectedRevision: -1,
      }),
    ).rejects.toThrow('expectedRevision');
    await expect(
      applyMode({
        // Known shape, unknown layer selector: normalization must fail loud.
        operations: [{ type: 'set_project_metadata', layerName: 'camada-fantasma-xyz' }],
        expectedRevision: 0,
        mode: 'apply',
      }),
    ).rejects.toThrow();
    expect(getHistorySnapshot().canUndo).toBe(false);
  });

  it('rejects hallucinated operation types instead of silently no-oping', async () => {
    await expect(
      applyMode({
        operations: [{ type: 'set_background_color', color: '#ff0000' }],
        expectedRevision: 0,
        mode: 'apply',
      }),
    ).rejects.toThrow(/unknown operation type.*set_background_color.*Valid types/s);
    // Nothing was applied and nothing entered the undo stack.
    expect(getHistorySnapshot().canUndo).toBe(false);
  });

  it('rejects batches with missing nested objects legibly, without engine TypeErrors', async () => {
    await applyMode({
      operations: [{ type: 'add_layer', kind: 'rectangle', name: 'Card' }],
      expectedRevision: 0,
      mode: 'apply',
    });
    const layers = useProjectStore.getState().project.compositions[0]!.layers;
    const layerId = layers[layers.length - 1]!.id;
    // Valid type but no `patch`: the preview/apply chain must name the
    // missing object instead of leaking `Cannot read properties ... 'type'`.
    await expect(
      applyMode({
        operations: [{ type: 'update_element', layerId }],
        expectedRevision: 0,
        mode: 'apply',
      }),
    ).rejects.toThrow(/requires a 'patch' object/);
    await expect(
      applyMode({ operations: 'nope', expectedRevision: 0, mode: 'apply' }),
    ).rejects.toThrow(/non-empty.*operations.*array/);
    // Direct catalog guard also rejects non-arrays and null items legibly.
    expect(() => assertKnownOperationTypes(null)).toThrow(/requires an `operations` array/);
    expect(() => assertKnownOperationTypes([null])).toThrow(/unknown operation type null/);
    // Nothing extra entered the undo stack beyond the Card layer.
    undo();
    expect(getHistorySnapshot().canUndo).toBe(false);
  });

  it('propose mode validates the batch so the worker can retry within the turn', async () => {
    await applyMode({
      operations: [{ type: 'add_layer', kind: 'rectangle', name: 'CardP' }],
      expectedRevision: 0,
      mode: 'apply',
    });
    const layers = useProjectStore.getState().project.compositions[0]!.layers;
    const layerId = layers[layers.length - 1]!.id;
    // Broken batches must fail here as tool errors (fed back to the model),
    // never as proposals that die later in the preview with no retry.
    await expect(
      applyMode({
        operations: [{ type: 'update_element', layerId }],
        expectedRevision: 0,
        mode: 'propose',
      }),
    ).rejects.toThrow(/requires a 'patch' object/);
    expect(getHistorySnapshot().canUndo).toBe(true);
    undo();
    expect(getHistorySnapshot().canUndo).toBe(false);
  });

  describe('sample_tracks returns real values (Fase 6B gap)', () => {
    interface SampleResult {
      compositionId: string;
      frames: number[];
      layers: Array<{
        layerId: string;
        name: string;
        kind: string;
        samples: Record<string, number[]>;
        keyframes: Record<string, Array<{ frame: number; value: number; easing: string }>>;
      }>;
    }
    async function sampleTracks(args: Record<string, unknown>): Promise<SampleResult> {
      return (await webmcpFallbackBridge.executeTool(
        'ograf_sample_tracks' as WebMCPToolName,
        args,
      )) as SampleResult;
    }
    it('samples interpolated values plus authored keyframes, never the stub', async () => {
      await applyMode({
        operations: [{ type: 'add_layer', kind: 'rectangle', name: 'SampleMe' }],
        expectedRevision: 0,
        mode: 'apply',
      });
      try {
        const result = await sampleTracks({ frames: [0, 12] });
        expect(result.compositionId).toEqual(expect.any(String));
        expect(result.frames).toEqual([0, 12]);
        expect(result.layers.length).toBeGreaterThan(0);
        expect(result).not.toHaveProperty('tracks');
        const first = result.layers[0]!;
        const properties = Object.keys(first.samples);
        expect(properties.length).toBeGreaterThan(0);
        for (const property of properties) {
          expect(first.samples[property]).toHaveLength(2);
          for (const value of first.samples[property]!) expect(typeof value).toBe('number');
          for (const keyframe of first.keyframes[property] ?? []) {
            expect(typeof keyframe.frame).toBe('number');
            expect(typeof keyframe.value).toBe('number');
            expect(typeof keyframe.easing).toBe('string');
          }
        }
      } finally {
        undo();
      }
    });
    it('filters by layerId and fails loud on unknown layers', async () => {
      await applyMode({
        operations: [{ type: 'add_layer', kind: 'rectangle', name: 'SampleOne' }],
        expectedRevision: 0,
        mode: 'apply',
      });
      try {
        const all = await sampleTracks({ frames: [0] });
        const layerId = all.layers[0]!.layerId;
        const one = await sampleTracks({ layerId, frames: [0] });
        expect(one.layers.map((layer) => layer.layerId)).toEqual([layerId]);
        await expect(sampleTracks({ layerId: 'camada-fantasma-xyz', frames: [0] })).rejects.toThrow(
          /Layer not found/,
        );
      } finally {
        undo();
      }
    });
    it('defaults to lifecycle frames when frames are omitted', async () => {
      const result = await sampleTracks({});
      expect(result.frames.length).toBeGreaterThan(0);
    });
  });
});
