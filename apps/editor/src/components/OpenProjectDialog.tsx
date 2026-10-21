import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@ograf-editor/scene-model';
import { openProjectFromFile } from '../state/fileIO';
import { useEditorWindow } from '../layout/EditorWindow';
import {
  getSouvAccTitle,
  isCloudSaveEnabled,
  isSouvLoggedIn,
  loginWithSouvPopup,
  onSouvAccountChange,
  onSouvAccTitleChange,
  onSouvAuthChange,
} from '../cloud/souvAuth';
import {
  deleteCloudProject,
  listCloudProjects,
  openProjectFromCloud,
  type CloudProjectSummary,
} from '../cloud/souvProjects';

/**
 * Unified Open dialog (OG-047): open from this computer (existing file-picker
 * flow, untouched) plus the signed-in user's Souv cloud projects below,
 * selectable to load. Login-gated; local flows never require login.
 */
export function OpenProjectDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (project: Project, label: string) => void;
}) {
  const { document: ownerDocument } = useEditorWindow();
  const dialogRef = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loggedIn, setLoggedIn] = useState(() => isSouvLoggedIn());
  const [accTitle, setAccTitle] = useState<string | null>(() => getSouvAccTitle());
  const [rows, setRows] = useState<CloudProjectSummary[] | null>(null);
  const cloudEnabled = isCloudSaveEnabled();

  const refresh = useCallback(async () => {
    setBusy('list');
    setError('');
    try {
      setRows(await listCloudProjects());
    } catch (cause) {
      setRows(null);
      setError(cause instanceof Error ? cause.message : 'Could not list cloud projects.');
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => onSouvAuthChange(() => setLoggedIn(isSouvLoggedIn())), []);
  useEffect(
    () =>
      onSouvAccountChange(() => {
        setAccTitle(getSouvAccTitle());
        // The list belongs to the previous account: reload.
        setRows(null);
      }),
    [],
  );
  useEffect(() => onSouvAccTitleChange((title) => setAccTitle(title)), []);
  useEffect(() => {
    if (cloudEnabled && loggedIn && rows === null && !busy && !error) void refresh();
  }, [cloudEnabled, loggedIn, rows, busy, error, refresh]);

  const openLocal = async () => {
    setError('');
    try {
      const opened = await openProjectFromFile();
      if (opened) onOpened(opened, `Opened "${opened.name}"`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to open project');
    }
  };

  const openCloud = async (row: CloudProjectSummary) => {
    setBusy(`open:${row.id}`);
    setError('');
    try {
      const opened = await openProjectFromCloud(row.id);
      onOpened(opened.project, `Opened "${opened.project.name}" from the Souv cloud.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to open cloud project');
    } finally {
      setBusy('');
    }
  };

  const login = async () => {
    setError('');
    try {
      await loginWithSouvPopup();
      setLoggedIn(isSouvLoggedIn());
      if (isSouvLoggedIn()) void refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Souv login failed');
    }
  };

  const removeCloud = async (row: CloudProjectSummary) => {
    if (
      !window.confirm(
        `Delete "${row.name}" from the Souv cloud? The editable source, published zip and thumbnail are removed. This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(`delete:${row.id}`);
    setError('');
    try {
      await deleteCloudProject(row.id);
      setRows((current) => (current ? current.filter((item) => item.id !== row.id) : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to delete cloud project');
    } finally {
      setBusy('');
    }
  };

  return createPortal(
    <section
      className="ograf-import-report remote-project-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-project-dialog-title"
      ref={dialogRef}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <div className="ograf-import-report-header">
        <div>
          <strong id="open-project-dialog-title">Open project</strong>
          <span>From this computer or your Souv cloud{accTitle ? ` — ${accTitle}` : ''}</span>
        </div>
        <button type="button" disabled={!!busy} onClick={onClose} aria-label="Close open dialog">
          ×
        </button>
      </div>

      <h3>From this computer</h3>
      <div className="ograf-import-report-actions">
        <button type="button" disabled={!!busy} onClick={() => void openLocal()}>
          Browse files…
        </button>
      </div>

      <h3>From Souv cloud</h3>
      {!cloudEnabled ? (
        <p>Cloud open is not configured. Set `VITE_SOUV_API` and restart the editor.</p>
      ) : !loggedIn ? (
        <div className="ograf-import-report-actions">
          <button type="button" disabled={!!busy} onClick={() => void login()}>
            {busy ? 'Opening…' : 'Log in with Souv'}
          </button>
        </div>
      ) : rows === null ? (
        <p>{busy === 'list' ? 'Loading cloud projects…' : 'No cloud projects loaded yet.'}</p>
      ) : rows.length === 0 ? (
        <p>No projects saved in your Souv account yet. Use Save with Souv cloud destination.</p>
      ) : (
        <ul className="open-cloud-list">
          {rows.map((row) => (
            <li key={row.id}>
              <span title={row.id}>
                {row.name} · rev {row.rev}
                {row.hasZip ? ' · zip' : ''}
              </span>
              <span className="open-cloud-actions">
                <button
                  type="button"
                  disabled={!!busy || !row.hasOgs}
                  title={row.hasOgs ? 'Load this project' : 'No editable source saved'}
                  onClick={() => void openCloud(row)}
                >
                  {busy === `open:${row.id}` ? 'Opening…' : 'Open'}
                </button>
                <button
                  type="button"
                  className="open-cloud-delete"
                  disabled={!!busy}
                  title="Delete this project from the Souv cloud"
                  onClick={() => void removeCloud(row)}
                >
                  {busy === `delete:${row.id}` ? 'Deleting…' : 'Delete'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div role="alert" className="template-save-error">
          {error}
          {loggedIn ? (
            <button type="button" onClick={() => void refresh()}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="ograf-import-report-actions">
        <button type="button" disabled={!!busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>,
    ownerDocument.body,
  );
}
