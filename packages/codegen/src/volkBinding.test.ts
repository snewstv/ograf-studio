import { describe, expect, it } from 'vitest';
import { validateManifest } from '@ograf-editor/validation';
import { createComposition, createFieldDefinition, createProject } from '@ograf-editor/scene-model';
import { assembleManifest, compileDataSchema, compileDescriptor } from './index';

describe('v_volk passthrough (fork addition)', () => {
  it('emits v_volk verbatim and omits it when absent', () => {
    const withBinding = createFieldDefinition('number', {
      key: 'temperature',
      label: 'Temperatura',
      volkBinding: {
        source: 'weather.currentTemp',
        params: { latitude: -3.1, longitude: -60 },
        live: true,
      },
    });
    const plain = createFieldDefinition('text', { key: 'name', label: 'Name' });
    const schema = compileDataSchema(
      createComposition({
        dataFields: [withBinding, plain],
      }),
    );
    expect(schema.properties.temperature).toMatchObject({
      type: 'number',
      title: 'Temperatura',
      v_volk: { source: 'weather.currentTemp' },
    });
    expect(schema.properties.name).not.toHaveProperty('v_volk');
  });

  it('assembles a manifest whose schema keeps v_volk and still validates', () => {
    const composition = createComposition({
      dataFields: [
        createFieldDefinition('number', {
          key: 'temperature',
          label: 'Temperatura',
          volkBinding: { source: 'weather.currentTemp' },
        }),
      ],
    });
    const project = createProject({ name: 'Volk check', compositions: [composition] });
    const manifest = assembleManifest(
      { ...project, mainCompositionId: composition.id },
      composition,
      compileDescriptor(composition),
    );
    const schema = manifest.schema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.temperature).toMatchObject({
      v_volk: { source: 'weather.currentTemp' },
    });
    const validation = validateManifest(manifest);
    expect(validation.errors).toEqual([]);
  });
});
