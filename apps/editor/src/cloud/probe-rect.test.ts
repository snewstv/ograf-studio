import { beforeEach, describe, expect, it } from 'vitest';
import { getHistorySnapshot, undo } from '../state/historyStore';
import { webmcpFallbackBridge, type WebMCPToolName } from './webmcpHost';

async function dry(args: Record<string, unknown>): Promise<unknown> {
  return webmcpFallbackBridge.executeTool('ograf_apply_operations' as WebMCPToolName, {
    expectedRevision: 0,
    mode: 'dry-run',
    ...args,
  });
}

/**
 * Shape-creation regression (Fase 6B): the assistant's bar-chart request
 * died because abbreviated kinds (kind: 'rect') failed with a leaked engine
 * TypeError. Valid shape batches validate; unknown kinds fail loudly with
 * the valid vocabulary instead of crashing on an undefined layer.
 */
describe('add_layer shape kinds (Fase 6B)', () => {
  beforeEach(() => {
    while (getHistorySnapshot().canUndo) undo();
  });
  it('bare rectangle', async () => {
    await expect(
      dry({ operations: [{ type: 'add_layer', kind: 'rectangle', name: 'P' }] }),
    ).resolves.toBeDefined();
  });
  it('rectangle with fill element', async () => {
    await expect(
      dry({
        operations: [
          { type: 'add_layer', kind: 'rectangle', name: 'P', element: { fill: '#ff0000' } },
        ],
      }),
    ).resolves.toBeDefined();
  });
  it('rectangle with transform and fill', async () => {
    await expect(
      dry({
        operations: [
          {
            type: 'add_layer',
            kind: 'rectangle',
            name: 'P',
            transform: { x: 100, y: 100, width: 200, height: 200 },
            element: { fill: '#ff0000' },
          },
        ],
      }),
    ).resolves.toBeDefined();
  });
  it('abbreviated kind fails loudly with the valid vocabulary', async () => {
    await expect(
      dry({ operations: [{ type: 'add_layer', kind: 'rect', name: 'P' }] }),
    ).rejects.toThrow(/Unknown layer kind.*rect.*rectangle/);
  });
});
