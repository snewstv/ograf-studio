import { describe, expect, it } from 'vitest';
import { createProject } from '@ograf-editor/scene-model';
import { applyAuthoringOperations } from '@ograf-editor/authoring-core';
import { normalizeOperationSelectors } from './normalizeOperations';

const project = () => createProject({ name: 'Fixture' });

describe('normalizeOperationSelectors structural gate', () => {
  it('normalizes a valid operation', () => {
    const typed = normalizeOperationSelectors(project(), [
      { type: 'set_project_metadata', name: 'Renamed' },
    ]);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.type).toBe('set_project_metadata');
  });

  it('rejects null items without crashing', () => {
    expect(() => normalizeOperationSelectors(project(), [null])).toThrow(
      /Operation 0: operation must be an object with a string type field \(got null\)/,
    );
  });

  it('rejects operations without a type (change de cor sem type)', () => {
    expect(() => normalizeOperationSelectors(project(), [{ frame: 45 }])).toThrow(
      /Operation 0: operation must be an object with a string type field/,
    );
  });

  it('rejects nested operation envelopes without crashing', () => {
    expect(() =>
      normalizeOperationSelectors(project(), [
        {
          operation: { type: 'set_project_metadata', name: 'X' },
        },
      ]),
    ).toThrow(/Operation 0: operation must be an object with a string type field/);
  });
});

describe('missing nested fields fail loud and legible (preview regression)', () => {
  const fixture = () => {
    const withCard = applyAuthoringOperations(project(), [
      { type: 'add_layer', kind: 'rectangle', name: 'Card' },
    ]).project;
    return { withCard, cardId: withCard.compositions[0]!.layers[0]!.id };
  };

  it.each([
    ['update_element', (id: string) => ({ type: 'update_element', layerId: id })],
    ['update_transform', (id: string) => ({ type: 'update_transform', layerId: id })],
    [
      'update_effect',
      (id: string) => ({ type: 'update_effect', layerId: id, effectId: 'fx-nope' }),
    ],
    ['update_effects', (id: string) => ({ type: 'update_effects', layerId: id })],
    ['set_layer_semantics', (id: string) => ({ type: 'set_layer_semantics', layerId: id })],
  ])('%s without patch names the missing patch object', (_label, makeOp) => {
    const { withCard, cardId } = fixture();
    const op = (makeOp as (id: string) => unknown)(cardId);
    expect(() => normalizeOperationSelectors(withCard, [op])).toThrow(
      /Operation 0: .* requires a 'patch' object/,
    );
    expect(String(consumedError(() => normalizeOperationSelectors(withCard, [op])))).not.toContain(
      'Cannot read properties',
    );
  });

  it.each([
    ['reorder_layers', { type: 'reorder_layers' }],
    ['add_asset', { type: 'add_asset' }],
    ['set_layer_bindings', { type: 'set_layer_bindings' }],
  ])('%s with missing fields never leaks engine TypeErrors', (_label, op) => {
    expect(() => normalizeOperationSelectors(project(), [op])).toThrow(/Operation 0: /);
    expect(String(consumedError(() => normalizeOperationSelectors(project(), [op])))).not.toContain(
      'Cannot read properties',
    );
  });
});

function consumedError(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}
