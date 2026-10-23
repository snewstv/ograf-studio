import { applyAuthoringOperations, type AuthoringOperation } from '@ograf-editor/authoring-core';
import { createId, getStylePack, type Project } from '@ograf-editor/scene-model';

function wildcardNameMatcher(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Rewrites engine TypeErrors from the dry-run apply into legible,
 * actionable messages. The dry run executes each normalized operation
 * against a projected clone; a missing nested object (e.g. an
 * `update_element` without `patch`) would otherwise surface as
 * `Cannot read properties of undefined (reading 'type')`. The rewritten
 * error keeps the accessed field for debuggability and never leaks the
 * engine phrasing to the chat.
 */
function dryRunError(index: number, type: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const inner = detail.replace(/^Operation \d+: /, '');
  const reading = /reading '([^']+)'/.exec(inner)?.[1];
  if (/Cannot read propert/.test(inner) && reading) {
    return new Error(
      `Operation ${index}: '${type}' is missing required fields (could not read '${reading}').`,
    );
  }
  if (/is not a function|is not iterable|Cannot use 'in' operator/.test(inner)) {
    return new Error(`Operation ${index}: '${type}' has missing or invalid fields (${inner}).`);
  }
  return new Error(`Operation ${index}: ${inner}`);
}

export function normalizeOperationSelectors(
  project: Project,
  operations: unknown[],
): AuthoringOperation[] {
  let projected = structuredClone(project);
  const normalized: AuthoringOperation[] = [];
  for (const [index, source] of operations.entries()) {
    // Structural gate: every later read assumes an object with a string
    // type (composition lookup, selector normalization, the applying
    // switch). Reject anything else here with index + expected field
    // instead of leaking Cannot read properties of undefined.
    const kind = source === null ? 'null' : Array.isArray(source) ? 'array' : typeof source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(
        'Operation ' +
          index +
          ': operation must be an object with a string type field (got ' +
          kind +
          ').',
      );
    }
    const operation = structuredClone(source) as Record<string, unknown>;
    if (typeof operation.type !== 'string' || !operation.type) {
      throw new Error(
        'Operation ' +
          index +
          ': operation must be an object with a string type field (got ' +
          kind +
          ' without a usable type).',
      );
    }
    const compositionId =
      typeof operation.compositionId === 'string'
        ? operation.compositionId
        : projected.mainCompositionId;
    const composition = projected.compositions.find((candidate) => candidate.id === compositionId);
    if (!composition)
      throw new Error(`Operation ${index}: composition not found: ${compositionId}`);

    if (operation.type === 'set_tiling_pattern') {
      if (operation.patternName) {
        if (operation.patternId) throw new Error('Use patternId or patternName, not both.');
        const matches = composition.patterns.filter(
          (pattern) => pattern.name === operation.patternName,
        );
        if (matches.length !== 1) throw new Error('Pattern name is missing or ambiguous.');
        operation.patternId = matches[0]!.id;
        delete operation.patternName;
      }
      if (!operation.patternId) operation.id = createId('pattern');
    }
    if (operation.type === 'set_layer_lighting' && operation.link) {
      operation.link = {
        phaseOffset: 0,
        gain: 1,
        cyclesPerLoop: 1,
        ...(operation.link as Record<string, unknown>),
      };
    }
    if (operation.type === 'add_effect' || operation.type === 'duplicate_effect')
      operation.id = createId('fx');
    if (operation.type === 'add_layer') operation.id = createId('layer');
    if (operation.type === 'add_data_field') operation.id = createId('field');
    if (operation.type === 'create_timeline_group') operation.id = createId('timeline-group');
    if (operation.type === 'group_layers') operation.id = createId('group');
    if (operation.type === 'save_component') operation.id = createId('component');
    if (operation.type === 'add_custom_action') operation.id = createId('action');
    if (operation.type === 'set_layer_loop') operation.id = createId('layer-loop');
    if (operation.type === 'create_runtime_collection')
      operation.id = createId('runtime-collection');
    if (operation.type === 'upsert_design_token' && !operation.tokenId) {
      operation.id = createId('design-token');
    }
    if (operation.type === 'apply_style_pack') {
      const pack = getStylePack(operation.stylePack as Parameters<typeof getStylePack>[0]);
      operation.tokenIds = Object.fromEntries(
        pack.tokens.map((definition) => [
          definition.key,
          composition.designSystem.tokens.find((token) => token.key === definition.key)?.id ??
            createId('design-token'),
        ]),
      );
    }

    if ('layerName' in operation || 'layerId' in operation) {
      const id = typeof operation.layerId === 'string' ? operation.layerId : undefined;
      const name = typeof operation.layerName === 'string' ? operation.layerName : undefined;
      if (id && name) {
        throw new Error(`Operation ${index}: pass layerId or layerName, not both.`);
      }
      if (!id && !name) {
        throw new Error(`Operation ${index}: layerId or layerName is required.`);
      }
      if (name) {
        const matches = composition.layers.filter((layer) => layer.name === name);
        if (matches.length !== 1) {
          const detail = matches.length
            ? matches.map((layer) => `${layer.name} (${layer.id})`).join(', ')
            : 'no matches';
          throw new Error(
            `Operation ${index}: layerName ${JSON.stringify(name)} is ${matches.length ? 'ambiguous' : 'unknown'}; ${detail}.`,
          );
        }
        operation.layerId = matches[0]!.id;
      }
      delete operation.layerName;
    }

    if (operation.type === 'set_layer_mask') {
      const name =
        typeof operation.sourceLayerName === 'string' ? operation.sourceLayerName : undefined;
      if (name && operation.sourceLayerId !== undefined)
        throw new Error(`Operation ${index}: pass sourceLayerId or sourceLayerName, not both.`);
      if (name) {
        const matches = composition.layers.filter((layer) => layer.name === name);
        if (matches.length !== 1)
          throw new Error(
            `Operation ${index}: mask sourceLayerName ${JSON.stringify(name)} is ${matches.length ? 'ambiguous' : 'unknown'}.`,
          );
        operation.sourceLayerId = matches[0]!.id;
      }
      if (operation.sourceLayerId === undefined)
        throw new Error(
          `Operation ${index}: sourceLayerId or sourceLayerName is required; use sourceLayerId:null to detach.`,
        );
      delete operation.sourceLayerName;
    }
    if (operation.type === 'stagger_property_track') {
      const ids = Array.isArray(operation.layerIds) ? operation.layerIds : undefined;
      const pattern =
        typeof operation.layerNamePattern === 'string' ? operation.layerNamePattern : undefined;
      if (ids && pattern) {
        throw new Error(`Operation ${index}: pass layerIds or layerNamePattern, not both.`);
      }
      if (!ids && !pattern) {
        throw new Error(`Operation ${index}: layerIds or layerNamePattern is required.`);
      }
      if (pattern) {
        const matcher = wildcardNameMatcher(pattern);
        operation.layerIds = composition.layers
          .filter((layer) => matcher.test(layer.name))
          .map((layer) => layer.id);
        if ((operation.layerIds as string[]).length === 0) {
          throw new Error(
            `Operation ${index}: layerNamePattern ${JSON.stringify(pattern)} matched no layers.`,
          );
        }
      }
      delete operation.layerNamePattern;
    }

    if (operation.type === 'set_layer_binding' || operation.type === 'set_layer_bindings') {
      const raw =
        operation.type === 'set_layer_binding'
          ? operation.binding
            ? [operation.binding]
            : []
          : operation.bindings;
      if (!Array.isArray(raw)) {
        throw new Error(`Operation ${index}: '${operation.type}' requires a bindings array.`);
      }
      const bindings = raw as unknown[];
      for (const rawBinding of bindings) {
        if (!rawBinding || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
          throw new Error(
            `Operation ${index}: binding must be an object with fieldId or fieldKey.`,
          );
        }
        const binding = rawBinding as Record<string, unknown>;
        const fieldId = typeof binding.fieldId === 'string' ? binding.fieldId : undefined;
        const fieldKey = typeof binding.fieldKey === 'string' ? binding.fieldKey : undefined;
        if (fieldId && fieldKey) {
          throw new Error(`Operation ${index}: binding accepts fieldId or fieldKey, not both.`);
        }
        if (!fieldId && !fieldKey) {
          throw new Error(`Operation ${index}: binding fieldId or fieldKey is required.`);
        }
        if (fieldKey) {
          const field = composition.dataFields.find((candidate) => candidate.key === fieldKey);
          if (!field) throw new Error(`Operation ${index}: data field key not found: ${fieldKey}`);
          binding.fieldId = field.id;
        }
        delete binding.fieldKey;
      }
    }

    if (operation.type === 'update_data_field') {
      const fieldId = typeof operation.fieldId === 'string' ? operation.fieldId : undefined;
      const fieldKey = typeof operation.fieldKey === 'string' ? operation.fieldKey : undefined;
      if (fieldId && fieldKey) {
        throw new Error(`Operation ${index}: pass fieldId or fieldKey, not both.`);
      }
      if (!fieldId && !fieldKey) {
        throw new Error(`Operation ${index}: fieldId or fieldKey is required.`);
      }
      if (fieldKey) {
        const matches = composition.dataFields.filter((field) => field.key === fieldKey);
        if (matches.length !== 1) {
          throw new Error(
            `Operation ${index}: fieldKey ${JSON.stringify(fieldKey)} is ${matches.length ? 'ambiguous' : 'unknown'}.`,
          );
        }
        operation.fieldId = matches[0]!.id;
      }
      delete operation.fieldKey;
    }

    if (
      operation.type === 'create_runtime_collection' ||
      operation.type === 'update_runtime_collection'
    ) {
      const fieldId = typeof operation.fieldId === 'string' ? operation.fieldId : undefined;
      const fieldKey = typeof operation.fieldKey === 'string' ? operation.fieldKey : undefined;
      if (fieldId && fieldKey) {
        throw new Error(`Operation ${index}: pass fieldId or fieldKey, not both.`);
      }
      if (operation.type === 'create_runtime_collection' && !fieldId && !fieldKey) {
        throw new Error(`Operation ${index}: fieldId or fieldKey is required.`);
      }
      if (fieldKey) {
        const matches = composition.dataFields.filter((field) => field.key === fieldKey);
        if (matches.length !== 1) {
          throw new Error(
            `Operation ${index}: fieldKey ${JSON.stringify(fieldKey)} is ${matches.length ? 'ambiguous' : 'unknown'}.`,
          );
        }
        operation.fieldId = matches[0]!.id;
      }
      delete operation.fieldKey;

      const layerIds = Array.isArray(operation.layerIds)
        ? (operation.layerIds as string[])
        : undefined;
      const layerNames = Array.isArray(operation.layerNames)
        ? (operation.layerNames as string[])
        : undefined;
      const groupId = typeof operation.groupId === 'string' ? operation.groupId : undefined;
      const selectorCount =
        Number(Boolean(layerIds)) + Number(Boolean(layerNames)) + Number(Boolean(groupId));
      if (selectorCount > 1) {
        throw new Error(
          `Operation ${index}: pass layerIds, layerNames, or groupId, not more than one.`,
        );
      }
      if (operation.type === 'create_runtime_collection' && selectorCount === 0) {
        throw new Error(`Operation ${index}: layerIds, layerNames, or groupId is required.`);
      }
      if (groupId) {
        const grouped = composition.layers.filter((layer) => layer.groupId === groupId);
        if (grouped.length === 0) {
          throw new Error(`Operation ${index}: canvas group not found or empty: ${groupId}`);
        }
        operation.prototypeLayerIds = grouped.map((layer) => layer.id);
      } else if (layerNames) {
        operation.prototypeLayerIds = layerNames.map((name) => {
          const matches = composition.layers.filter((layer) => layer.name === name);
          if (matches.length !== 1) {
            throw new Error(
              `Operation ${index}: layer name ${JSON.stringify(name)} is ${matches.length ? 'ambiguous' : 'unknown'}.`,
            );
          }
          return matches[0]!.id;
        });
      } else if (layerIds) {
        operation.prototypeLayerIds = layerIds;
      }
      delete operation.layerIds;
      delete operation.layerNames;
      delete operation.groupId;
    }

    if (operation.type === 'bind_design_token') {
      const tokenId = typeof operation.tokenId === 'string' ? operation.tokenId : undefined;
      const tokenKey = typeof operation.tokenKey === 'string' ? operation.tokenKey : undefined;
      if (tokenId && tokenKey) {
        throw new Error(`Operation ${index}: pass tokenId or tokenKey, not both.`);
      }
      if (!tokenId && !tokenKey) {
        throw new Error(`Operation ${index}: tokenId or tokenKey is required.`);
      }
      if (tokenKey) {
        const token = composition.designSystem.tokens.find(
          (candidate) => candidate.key === tokenKey,
        );
        if (!token) throw new Error(`Operation ${index}: design-token key not found: ${tokenKey}`);
        operation.tokenId = token.id;
      }
      delete operation.tokenKey;
    }

    const typedOperation = operation as unknown as AuthoringOperation;
    normalized.push(typedOperation);
    // Preallocated IDs make ordinary create-then-target sequences deterministic in this projection
    // and in the final atomic apply. Duplicate-group outputs deliberately remain follow-up targets
    // through their returned mappings because each copy creates a variable number of IDs.
    if (typedOperation.type !== 'duplicate_group') {
      try {
        projected = applyAuthoringOperations(projected, [typedOperation]).project;
      } catch (error) {
        throw dryRunError(index, typedOperation.type, error);
      }
    }
  }
  return normalized;
}
