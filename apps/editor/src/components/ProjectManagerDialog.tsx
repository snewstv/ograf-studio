import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '@ograf-editor/scene-model';
import { useEditorWindow } from '../layout/EditorWindow';
import {
  getSouvAccID,
  isCloudSaveEnabled,
  isSouvLoggedIn,
  loginWithSouvPopup,
  onSouvAccountChange,
  onSouvAuthChange,
  setSouvAccID,
} from '../cloud/souvAuth';
import {
  copyCloudProjectToAccount,
  deleteCloudProject,
  downloadCloudZip,
  listCloudProjects,
  listSouvAccounts,
  openProjectFromCloud,
  renameCloudProject,
  type CloudAccount,
  type CloudProjectSummary,
} from '../cloud/souvProjects';

/**
 * Souv project manager (OG-048): lists the signed-in user's cloud projects
 * and exports in one place — open, download `.ograf.zip`, rename (via the
 * blessed open + save path, guarded by the live `expectedRev`), delete.
 * Login-gated; rows without an editable source can't be opened or renamed.
 */
export function ProjectManagerDialog({
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
  const [rows, setRows] = useState<CloudProjectSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [accID, setAccID] = useState<string | null>(() => getSouvAccID());
  const [copyId, setCopyId] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState('');
  const [notice, setNotice] = useState('');
  const cloudEnabled = isCloudSaveEnabled();

  const refresh = useCallback(async (query?: string) => {
    setBusy('list');
    setError('');
    try {
      setRows(await listCloudProjects(query?.trim() ? { query } : undefined));
    } catch (cause) {
      setRows(null);
      setError(cause instanceof Error ? cause.message : 'Could not list cloud projects.');
    } finally {
      setBusy('');
    }
  }, []);

  useEffect(() => onSouvAuthChange(() => setLoggedIn(isSouvLoggedIn())), []);
  // Another surface (Souv menu) may switch accounts while open: reload.
  useEffect(
    () =>
      onSouvAccountChange((id) => {
        setAccID(id);
        setRows(null);
      }),
    [],
  );
  useEffect(() => {
    if (cloudEnabled && loggedIn && rows === null && !busy && !error) void refresh(search);
  }, [cloudEnabled, loggedIn, rows, busy, error, refresh, search]);
  useEffect(() => {
    if (!cloudEnabled || !loggedIn || accounts !== null) return;
    void listSouvAccounts()
      .then((loaded) => setAccounts(loaded))
      .catch(() => {
        // Non-fatal: the list works against the default/personal account.
      });
  }, [cloudEnabled, loggedIn, accounts]);
  // Debounced server-side search (backend `query` filter). Armed only after
  // the first list resolves, and keyed on `search` alone: depending on `rows`
  // would re-arm on every refresh and poll forever.
  const searchArmed = useRef(false);
  useEffect(() => {
    if (!cloudEnabled || !loggedIn || rows === null) return;
    if (!searchArmed.current) {
      searchArmed.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh(search);
    }, 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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

  const downloadZip = async (row: CloudProjectSummary) => {
    setBusy(`zip:${row.id}`);
    setError('');
    try {
      await downloadCloudZip(row);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to download the package');
    } finally {
      setBusy('');
    }
  };

  const saveRename = async (row: CloudProjectSummary) => {
    setBusy(`rename:${row.id}`);
    setError('');
    try {
      const saved = await renameCloudProject(row, draftName);
      setRows((current) =>
        current ? current.map((item) => (item.id === row.id ? saved : item)) : current,
      );
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to rename cloud project');
    } finally {
      setBusy('');
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

  const switchAccount = (accountID: string) => {
    const target = accounts?.find((account) => account.id === accountID);
    if (!target) return;
    // Option values are always real account ids (unique, so the select
    // always reflects the pick); only the stored selection uses null for
    // the personal account.
    setSouvAccID(target.isMe ? null : target.id, target.title);
    setAccID(target.isMe ? null : target.id);
    setCopyId(null);
    setNotice('');
    setRows(null);
  };

  const personalID = accounts?.find((account) => account.isMe)?.id ?? null;
  const activeID = accID ?? personalID;
  const copyTargets = (accounts ?? []).filter(
    (account) => account.id !== activeID && account.canWrite,
  );

  const copyToAccount = async (row: CloudProjectSummary) => {
    const target = (accounts ?? []).find((account) => account.id === copyTarget);
    const targetID = target?.id ?? '';
    if (!target || !targetID || targetID === activeID) {
      setError('Pick a different account as the copy destination.');
      return;
    }
    if (
      !window.confirm(
        `Copy "${row.name}" to ${target.title}? A copy with a new project id will be created there${row.hasZip ? ', including a rebuilt published package' : ''}. Copying again creates another copy.`,
      )
    ) {
      return;
    }
    setBusy(`copy:${row.id}`);
    setError('');
    setNotice('');
    try {
      await copyCloudProjectToAccount(row, targetID);
      setCopyId(null);
      setNotice(`Copied "${row.name}" to ${target.title}. Switch account to see it.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to copy cloud project');
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

  return createPortal(
    <section
      className="ograf-import-report remote-project-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-manager-dialog-title"
      ref={dialogRef}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy && !editingId && !copyId) onClose();
      }}
    >
      <div className="ograf-import-report-header">
        <div>
          <strong id="project-manager-dialog-title">Manage Souv projects</strong>
          <span>Projects and published packages in your Souv cloud</span>
        </div>
        <button
          type="button"
          disabled={!!busy}
          onClick={onClose}
          aria-label="Close project manager"
        >
          ×
        </button>
      </div>

      {!cloudEnabled ? (
        <p>Cloud projects are not configured. Set `VITE_SOUV_API` and restart the editor.</p>
      ) : !loggedIn ? (
        <div className="ograf-import-report-actions">
          <button type="button" disabled={!!busy} onClick={() => void login()}>
            {busy ? 'Opening…' : 'Log in with Souv'}
          </button>
        </div>
      ) : (
        <div className="open-cloud-search">
          {accounts && accounts.length > 1 ? (
            <label className="open-cloud-account">
              <span>Account</span>
              <select
                value={activeID ?? ''}
                disabled={!!busy}
                onChange={(event) => switchAccount(event.target.value)}
                aria-label="Souv account for projects"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.title}
                    {account.isMe ? ' (personal)' : ''}
                    {account.canWrite ? '' : ' · read-only'}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <input
            type="search"
            placeholder="Search projects…"
            value={search}
            disabled={!!busy}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search cloud projects"
          />
        </div>
      )}
      {notice ? <p className="open-cloud-notice">{notice}</p> : null}
      {cloudEnabled && loggedIn ? (
        rows === null ? (
          <p>{busy === 'list' ? 'Loading cloud projects…' : 'No cloud projects loaded yet.'}</p>
        ) : rows.length === 0 ? (
          <p>
            {search.trim()
              ? `No projects match "${search.trim()}".`
              : 'No projects saved in your Souv account yet. Use Save with Souv cloud destination.'}
          </p>
        ) : (
          <ul className="open-cloud-list">
            {rows.map((row) => (
              <li key={row.id}>
                {editingId === row.id ? (
                  <span className="open-cloud-edit">
                    <input
                      autoFocus
                      type="text"
                      value={draftName}
                      maxLength={200}
                      disabled={!!busy}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') void saveRename(row);
                        if (event.key === 'Escape') setEditingId(null);
                      }}
                      aria-label="New project name"
                    />
                    <button
                      type="button"
                      disabled={!!busy || !draftName.trim()}
                      onClick={() => void saveRename(row)}
                    >
                      {busy === `rename:${row.id}` ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span title={row.id}>
                    {row.name} · rev {row.rev}
                    {row.hasOgs ? '' : ' · no source'}
                    {row.hasZip ? ' · zip' : ''}
                  </span>
                )}
                {editingId === row.id ? null : (
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
                      disabled={!!busy || !row.hasZip}
                      title={
                        row.hasZip
                          ? 'Download the published .ograf.zip'
                          : 'No published package yet'
                      }
                      onClick={() => void downloadZip(row)}
                    >
                      {busy === `zip:${row.id}` ? 'Getting…' : 'ZIP'}
                    </button>
                    <button
                      type="button"
                      disabled={!!busy}
                      title="Rename this project"
                      onClick={() => {
                        setEditingId(row.id);
                        setDraftName(row.name);
                        setError('');
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={!!busy || !row.hasOgs}
                      title={
                        row.hasOgs
                          ? 'Copy this project to another account'
                          : 'Needs an editable source to copy'
                      }
                      onClick={() => {
                        const first = copyTargets[0];
                        setCopyId(row.id);
                        setCopyTarget(first ? first.id : '');
                        setError('');
                        setNotice('');
                      }}
                    >
                      Copy to…
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
                )}
                {copyId === row.id ? (
                  <span className="open-cloud-edit">
                    {copyTargets.length === 0 ? (
                      <span>No other writable account available.</span>
                    ) : (
                      <select
                        value={copyTarget}
                        disabled={!!busy}
                        onChange={(event) => setCopyTarget(event.target.value)}
                        aria-label="Destination account for the copy"
                      >
                        {copyTargets.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.title}
                            {account.isMe ? ' (personal)' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      disabled={!!busy || copyTargets.length === 0}
                      onClick={() => void copyToAccount(row)}
                      title="Copy the editable source and published package to the selected account"
                    >
                      {busy === `copy:${row.id}` ? 'Copying…' : 'Copy'}
                    </button>
                    <button type="button" disabled={!!busy} onClick={() => setCopyId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}

      {error ? (
        <div role="alert" className="template-save-error">
          {error}
          {loggedIn ? (
            <button type="button" onClick={() => void refresh(search)}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="ograf-import-report-actions">
        {loggedIn && rows !== null ? (
          <button type="button" disabled={!!busy} onClick={() => void refresh(search)}>
            Refresh
          </button>
        ) : null}
        <button type="button" disabled={!!busy} onClick={onClose}>
          Close
        </button>
      </div>
    </section>,
    ownerDocument.body,
  );
}
