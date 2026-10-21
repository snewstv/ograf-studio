import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorWindow } from '../layout/EditorWindow';
import { getSouvAccID, onSouvAccountChange, setSouvAccID } from '../cloud/souvAuth';
import { listSouvAccounts, type CloudAccount } from '../cloud/souvProjects';

/**
 * Account picker: lists every Souv account the login can access (personal +
 * invited) in its own dialog instead of crowding the Souv menu. Picking one
 * retargets all saves/exports/lists (the selected `accID`). Read-only
 * accounts stay selectable: listing works, saves fail high on the backend.
 */
export function AccountSelectDialog({
  onClose,
  onSelected,
}: {
  onClose: () => void;
  onSelected?: (account: CloudAccount) => void;
}) {
  const { document: ownerDocument } = useEditorWindow();
  const dialogRef = useRef<HTMLElement>(null);
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [accID, setAccID] = useState<string | null>(() => getSouvAccID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setAccounts(await listSouvAccounts());
      setAccID(getSouvAccID());
    } catch (cause) {
      setAccounts(null);
      setError(cause instanceof Error ? cause.message : 'Could not list Souv accounts.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Another tab may switch accounts while this dialog is open.
  useEffect(() => onSouvAccountChange((id) => setAccID(id)), []);

  const personal = accounts?.find((account) => account.isMe) ?? null;
  const activeID = accID ?? personal?.id ?? null;

  const select = (account: CloudAccount) => {
    setSouvAccID(account.isMe ? null : account.id, account.title);
    onSelected?.(account);
    onClose();
  };

  return createPortal(
    <section
      className="ograf-import-report remote-project-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-select-dialog-title"
      ref={dialogRef}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <div className="ograf-import-report-header">
        <div>
          <strong id="account-select-dialog-title">Select Souv account</strong>
          <span>Saves, exports and project lists target this account</span>
        </div>
        <button type="button" disabled={busy} onClick={onClose} aria-label="Close account selector">
          ×
        </button>
      </div>

      {accounts === null ? (
        <p>{busy ? 'Loading accounts…' : 'No accounts loaded yet.'}</p>
      ) : accounts.length === 0 ? (
        <p>No Souv accounts found for this login.</p>
      ) : (
        <ul className="open-cloud-list">
          {accounts.map((account) => {
            const active = activeID === account.id;
            return (
              <li key={account.id}>
                <span title={account.id}>
                  {active ? '✓ ' : ''}
                  {account.title}
                  {account.isMe ? ' (personal)' : ''}
                  {account.canWrite ? '' : ' · read-only'}
                </span>
                <span className="open-cloud-actions">
                  <button
                    type="button"
                    disabled={busy || active}
                    title={
                      account.canWrite
                        ? `Save, export and manage projects in ${account.title}`
                        : `${account.title} is read-only: listing works, saves will fail`
                    }
                    onClick={() => select(account)}
                  >
                    {active ? 'Current' : 'Select'}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <div role="alert" className="template-save-error">
          {error}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="ograf-import-report-actions">
        {accounts !== null ? (
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>,
    ownerDocument.body,
  );
}
