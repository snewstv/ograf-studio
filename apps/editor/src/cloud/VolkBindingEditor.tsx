import { useEffect, useState } from 'react';
import type { FieldDefinition, VolkFieldBinding } from '@ograf-editor/scene-model';
import { fetchVolkSources, findVolkSource, type VolkSourceDef } from './volkFields';
import './VolkBindingEditor.css';

interface Props {
  field: FieldDefinition;
  update: (fieldId: string, patch: Partial<Pick<FieldDefinition, 'volkBinding'>>) => void;
}

function parseFallback(
  text: string,
  fieldType: FieldDefinition['type'],
): string | number | boolean {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  // Text-like fields keep raw strings: JSON-coercing "123" into a number or
  // "true" into a boolean would silently change the field's data type.
  if (fieldType === 'text' || fieldType === 'textarea' || fieldType === 'select') {
    return text;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean') {
      return parsed;
    }
  } catch {
    // Not JSON — fall through to raw string.
  }
  return text;
}

function BindingDetails({
  binding,
  field,
  set,
}: {
  binding: VolkFieldBinding;
  field: FieldDefinition;
  set: (next: VolkFieldBinding | null) => void;
}) {
  return (
    <>
      {Object.entries(binding.params ?? {}).map(([key, value]) => (
        <label key={key}>
          <span>Param: {key}</span>
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(event) =>
              set({ ...binding, params: { ...binding.params, [key]: event.target.value } })
            }
          />
        </label>
      ))}
      <label>
        <span>Fallback (offline/default)</span>
        <input
          type="text"
          value={
            binding.fallback === undefined || binding.fallback === null
              ? ''
              : typeof binding.fallback === 'string'
                ? binding.fallback
                : JSON.stringify(binding.fallback)
          }
          placeholder="Used when the live source is unavailable"
          onChange={(event) =>
            set({ ...binding, fallback: parseFallback(event.target.value, field.type) })
          }
        />
      </label>
      <label className="data-field-volk-live">
        <input
          type="checkbox"
          checked={binding.live ?? true}
          onChange={(event) => set({ ...binding, live: event.target.checked })}
        />
        <span>Refresh live on each playout</span>
      </label>
      <p className="inspector-hint">
        Compiles to manifest `v_volk: {`{`}"source": "{binding.source}"`{`}}`}. Third-party
        renderers ignore it; Volk autocompletes it.
      </p>
      <button type="button" onClick={() => set(null)}>
        Remove Volk binding
      </button>
    </>
  );
}

/**
 * Volk live-data binding editor (OG-082). The source list ALWAYS comes from
 * the Volk backend (`GET /api/ograf/sources`); when unreachable, only a
 * free-form custom source is shown — never an empty/stale select. Empty stays
 * a plain OGraf field with no vendor data. Stores an opaque
 * `{ source, params, fallback, live }` record on the field; `codegen` emits it
 * verbatim as manifest `v_volk`. Removing it yields pure OGraf again.
 */
export function VolkBindingEditor({ field, update }: Props) {
  const binding = field.volkBinding ?? null;
  const [custom, setCustom] = useState('');
  const [sources, setSources] = useState<VolkSourceDef[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    fetchVolkSources()
      .then((list) => {
        if (!cancelled) setSources(list);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSources([]);
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (next: VolkFieldBinding | null) => update(field.id, { volkBinding: next });
  const known = binding ? findVolkSource(sources ?? [], binding.source) : undefined;

  const onSelect = (value: string) => {
    if (value === '') {
      set(null);
      return;
    }
    if (value === '__custom') {
      const source = custom.trim();
      if (!source) return;
      set({ source });
      return;
    }
    const previous = binding?.source === value ? binding : undefined;
    const paramNames = findVolkSource(sources ?? [], value)?.params ?? [];
    set({
      source: value,
      params: Object.fromEntries(paramNames.map((key) => [key, previous?.params?.[key] ?? ''])),
      ...(previous?.fallback !== undefined ? { fallback: previous.fallback } : {}),
      live: previous?.live ?? true,
    });
  };

  if (loadError || (sources !== null && sources.length === 0 && !binding)) {
    return (
      <div className="data-field-volk">
        {loadError && (
          <p className="inspector-hint">
            Volk catalog unreachable: {loadError} Type a custom source below, or leave empty for a
            plain OGraf field.
          </p>
        )}
        <label>
          <span>Volk source (custom)</span>
          <input
            type="text"
            value={binding ? binding.source : custom}
            placeholder="clock.now"
            onChange={(event) => {
              const source = event.target.value;
              if (binding) {
                if (!source.trim()) set(null);
                else if (source.trim() !== binding.source) set({ source: source.trim() });
              } else {
                setCustom(source);
              }
            }}
            onBlur={() => {
              if (!binding && custom.trim()) {
                set({ source: custom.trim() });
              }
            }}
          />
        </label>
        {binding && <BindingDetails binding={binding} field={field} set={set} />}
      </div>
    );
  }

  return (
    <div className="data-field-volk">
      <label>
        <span>Volk source</span>
        <select
          aria-label={`${field.label || field.key} Volk source`}
          disabled={sources === null}
          value={binding?.source && known ? binding.source : binding ? '__custom' : ''}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">None (plain OGraf field)</option>
          <optgroup label="Available now (Volk backend)">
            {(sources ?? [])
              .filter((entry) => entry.working)
              .map((entry) => (
                <option key={entry.source} value={entry.source}>
                  {entry.source}
                </option>
              ))}
          </optgroup>
          <optgroup label="Unavailable in backend">
            {(sources ?? [])
              .filter((entry) => !entry.working)
              .map((entry) => (
                <option key={entry.source} value={entry.source} disabled>
                  {entry.source}
                </option>
              ))}
          </optgroup>
          <option value="__custom">Custom source…</option>
        </select>
      </label>
      {sources === null && !loadError && <p className="inspector-hint">Loading Volk sources…</p>}
      {(!binding || !known) && (
        <label>
          <span>Custom source</span>
          <input
            type="text"
            value={binding && !known ? binding.source : custom}
            placeholder="clock.now"
            onChange={(event) => {
              const source = event.target.value;
              if (findVolkSource(sources ?? [], source)) {
                onSelect(source);
              } else {
                setCustom(source);
              }
            }}
            onBlur={() => {
              if (custom.trim() && (!binding || binding.source !== custom.trim())) {
                set({ source: custom.trim() });
              }
            }}
          />
        </label>
      )}
      {binding && <BindingDetails binding={binding} field={field} set={set} />}
    </div>
  );
}
