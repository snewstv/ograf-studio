/**
 * Cloud project storage against the Souv GraphQL API (matrix S1/S2/E1-nuvem).
 *
 * Transport: `POST {SOUV_API}/api/graphql` with `{ query, variables }`.
 * Auth unchanged: Bearer when a token exists, cookies always
 * (`credentials: 'include'`). Errors arrive as GraphQL `errors[]` with
 * HTTP 200 — including rev conflicts (`Revision conflict: cloud is at rev X`)
 * and auth failures (session expired).
 *
 * Payloads reuse the exact local serializations so cloud and disk stay
 * byte-compatible: `.ogs` is the same JSON as `Save Project`, and the published
 * `.ograf.zip` is produced by the same certified builder. `v_volk` bindings
 * travel inside the project JSON untouched.
 */

import type { Project } from '@ograf-editor/scene-model';
import { createId, templateThumbnailName } from '@ograf-editor/scene-model';
import { getExportProfile } from '@ograf-editor/codegen';
import { openProjectFromUrl } from '../state/fileIO';
import { blobToBase64, buildCertifiedZip } from '../state/exportPackage';
import { createTemplateThumbnail } from '../state/templateThumbnail';
import {
  clearSouvToken,
  getSouvAccID,
  getSouvApiBase,
  getSouvToken,
  gqlErrorMessages,
  requireSouvLogin,
  setSouvAccID,
  syncSouvAccTitle,
} from './souvAuth';

export const MAX_CLOUD_PROJECT_BYTES = 32 * 1024 * 1024;

export interface CloudProjectSummary {
  id: string;
  name: string;
  /** Optimistic-concurrency revision (OG-045). Pass back as `expectedRev`. */
  rev: number;
  updatedAt: string;
  hasOgs: boolean;
  hasZip: boolean;
  volkSources: string[];
}

interface ApiProjectRow {
  id: string;
  name: string;
  rev: number;
  updatedAt: string;
  hasOgs: boolean;
  hasZip: boolean;
  volkSources?: string[];
}

interface ApiOpenRow extends ApiProjectRow {
  version?: string;
  manifest?: unknown;
  downloadOgsUrl?: string | null;
  downloadZipUrl?: string | null;
  ogs?: Project | null;
}

const OGRAF_LIST_QUERY = `query OgrafList($first: Int, $after: String, $query: String, $accID: ID) {
  ografProjects(accID: $accID, first: $first, after: $after, query: $query) {
    edges { cursor node { id name rev hasOgs hasZip updatedAt volkSources } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const OGRAF_OPEN_QUERY = `query OgrafOpen($id: ID!, $accID: ID) {
  ografProject(accID: $accID, id: $id) {
    id name rev version hasOgs hasZip updatedAt volkSources
    manifest downloadOgsUrl downloadZipUrl
    ogs
  }
}`;

const OGRAF_SAVE_MUTATION = `mutation OgrafSave($id: ID!, $content: OgrafProjectSaveInput!, $accID: ID) {
  ografProjectSave(accID: $accID, id: $id, content: $content) {
    id name rev hasOgs hasZip updatedAt volkSources
  }
}`;

const OGRAF_PUBLISH_MUTATION = `mutation OgrafPublish($id: ID!, $content: OgrafBundlePublishInput!, $accID: ID) {
  ografBundlePublish(accID: $accID, id: $id, content: $content) {
    id name rev version hasZip updatedAt
  }
}`;

/**
 * Delete contract: `mutation OgrafDelete($id: ID!) { ografProjectDelete(id: $id) }`
 * returning a Boolean. A `false`/null answer (or GraphQL error) throws
 * instead of pretending the row is gone.
 */
const OGRAF_DELETE_MUTATION = `mutation OgrafDelete($id: ID!, $accID: ID) {
  ografProjectDelete(accID: $accID, id: $id)
}`;

function collectVolkSources(project: Project): string[] {
  const sources = new Set<string>();
  for (const composition of project.compositions) {
    for (const field of composition.dataFields) {
      const source = field.volkBinding?.source;
      if (source) sources.add(source);
    }
  }
  return [...sources].sort();
}

function ensureSizeOk(bytes: number, what: string): void {
  if (bytes > MAX_CLOUD_PROJECT_BYTES) {
    throw new Error(
      `${what} exceeds the 32 MiB cloud limit. Remove embedded assets and try again.`,
    );
  }
}

function isAuthFailure(message: string): boolean {
  return /unauthori[sz]ed|expired|invalid token|not authenticated/i.test(message);
}

/** POSTs a GraphQL operation, throwing legible errors for `errors[]`. */
async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  action: string,
): Promise<T> {
  const base = getSouvApiBase();
  if (!base) {
    throw new Error(
      'Cloud save is not configured. Set VITE_SOUV_API (and VITE_CLOUD_SAVE=1) and restart the editor.',
    );
  }
  const token = await requireSouvLogin();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${base}/api/graphql`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error(`Could not reach the Souv cloud at ${base}. Check the network connection.`);
  }
  let envelope: { data?: T; errors?: Array<{ message?: string }> } | null = null;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`Cloud ${action} failed with HTTP ${response.status}.`);
  }
  const messages = gqlErrorMessages(envelope);
  if (messages.length > 0) {
    const joined = messages.slice(0, 3).join(' ');
    if (isAuthFailure(joined)) {
      clearSouvToken();
      throw new Error('Your Souv session expired. Log in again.');
    }
    throw new Error(joined);
  }
  if (!response.ok) throw new Error(`Cloud ${action} failed with HTTP ${response.status}.`);
  const data = envelope?.data;
  if (!data) throw new Error(`Cloud ${action} returned no data.`);
  return data;
}

/**
 * Rev conflicts arrive as GraphQL errors (`Revision conflict: cloud is at
 * rev X, ...`) or races (`Concurrent save|publish detected`). Re-read the
 * cloud revision so the message carries the current rev.
 *
 * NOTE: this never calls `gqlRequest` — that would re-enter `requireSouvLogin`
 * and could pop a login popup in the middle of conflict handling. It reads
 * with the current token (if any) + cookies, and falls back to the original
 * error when the re-read itself fails.
 */
async function throwRevConflict(
  id: string,
  fallback: Error,
  accID?: string | null,
): Promise<never> {
  const concurrent = /concurrent (save|publish)/i.test(fallback.message);
  try {
    const rev = await readCloudRev(id, accID ?? getSouvAccID());
    if (typeof rev === 'number') {
      throw new Error(
        concurrent
          ? `Concurrent save detected (cloud is at rev ${rev}). Reload the project and try again.`
          : `Revision conflict: cloud is at rev ${rev}. Reload the cloud project and reapply your changes.`,
        { cause: fallback },
      );
    }
  } catch (error) {
    if (error instanceof Error && /cloud is at rev \d+/.test(error.message)) {
      throw error;
    }
    // Fall through to the original error when the re-read itself fails.
  }
  throw fallback;
}

/** Reads the live cloud `rev` without ever triggering the login popup. */
async function readCloudRev(
  id: string,
  accID: string | null = getSouvAccID(),
): Promise<number | null> {
  const base = getSouvApiBase();
  if (!base) return null;
  const token = getSouvToken();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({
      query: `query OgrafRev($id: ID!, $accID: ID) { ografProject(accID: $accID, id: $id) { rev } }`,
      variables: { accID, id },
    }),
  });
  if (!response.ok) return null;
  const envelope = (await response.json().catch(() => null)) as {
    data?: { ografProject?: { rev?: unknown } | null };
    errors?: Array<{ message?: string }>;
  } | null;
  if (gqlErrorMessages(envelope).length > 0) return null;
  const rev = envelope?.data?.ografProject?.rev;
  return typeof rev === 'number' ? rev : null;
}

function isRevConflict(error: unknown): boolean {
  return (
    error instanceof Error && /revision conflict|concurrent (save|publish)/i.test(error.message)
  );
}

/** S2-nuvem: list the signed-in user's cloud projects. Requires login. */
export async function listCloudProjects(options?: {
  query?: string;
}): Promise<CloudProjectSummary[]> {
  type OgrafListResult = {
    ografProjects: {
      edges: Array<{ cursor: string; node: ApiProjectRow }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    } | null;
  };
  const rows: ApiProjectRow[] = [];
  const query = options?.query?.trim() ? options.query.trim() : undefined;
  let after: string | null = null;
  // Paginate the connection (backend caps pages); hard cap avoids runaway loops.
  for (let page = 0; page < 10; page++) {
    const data: OgrafListResult = await gqlRequest<OgrafListResult>(
      OGRAF_LIST_QUERY,
      {
        accID: getSouvAccID(),
        first: 100,
        after,
        ...(query ? { query } : {}),
      },
      'list',
    );
    const connection = data.ografProjects;
    if (!connection) break;
    for (const edge of connection.edges ?? []) {
      if (edge?.node) rows.push(edge.node);
    }
    const pageInfo = connection.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }
  return rows.map((row) => {
    // Fail closed: every downstream flow (open/save `expectedRev`) depends on
    // `rev`, so a row without one is a backend contract break, not a rev 0.
    if (typeof row.rev !== 'number') {
      throw new Error(
        `Cloud project "${row.name}" came back without a revision. Reload the list and try again.`,
      );
    }
    return {
      id: row.id,
      name: row.name,
      rev: row.rev,
      updatedAt: row.updatedAt,
      hasOgs: row.hasOgs,
      hasZip: row.hasZip,
      volkSources: row.volkSources ?? [],
    };
  });
}

/** S1-nuvem: save editable `.ogs` source + thumbnail to the Souv cloud. Requires login. */
export async function saveProjectToCloud(
  project: Project,
  options: { expectedRev?: number; accID?: string | null } = {},
): Promise<CloudProjectSummary> {
  const snapshot = JSON.parse(JSON.stringify(project)) as Project;
  const ogsText = JSON.stringify(snapshot, null, 2);
  ensureSizeOk(new TextEncoder().encode(ogsText).byteLength, 'The editable project source');

  const thumbnail = await createTemplateThumbnail(snapshot);
  const thumbBuffer = new Uint8Array(await thumbnail.arrayBuffer());
  let thumbBinary = '';
  for (let i = 0; i < thumbBuffer.length; i++) thumbBinary += String.fromCharCode(thumbBuffer[i]!);
  const thumbDataUri = `data:${thumbnail.type || 'image/png'};base64,${btoa(thumbBinary)}`;

  let saved: {
    id: string;
    name: string;
    rev: number;
    hasOgs: boolean;
    hasZip: boolean;
    updatedAt: string;
    volkSources?: string[];
  };
  try {
    const data = await gqlRequest<{
      ografProjectSave: {
        id: string;
        name: string;
        rev: number;
        hasOgs: boolean;
        hasZip: boolean;
        updatedAt: string;
        volkSources?: string[];
      };
    }>(
      OGRAF_SAVE_MUTATION,
      {
        accID: options.accID ?? getSouvAccID(),
        id: snapshot.id,
        content: {
          ogs: snapshot,
          name: snapshot.name,
          thumbDataUri,
          thumbName: templateThumbnailName(snapshot),
          volkSources: collectVolkSources(snapshot).slice(0, 100),
          ...(options.expectedRev !== undefined ? { expectedRev: options.expectedRev } : {}),
        },
      },
      'save',
    );
    saved = data.ografProjectSave;
  } catch (error) {
    if (isRevConflict(error))
      await throwRevConflict(snapshot.id, error as Error, options.accID ?? getSouvAccID());
    throw error;
  }
  return {
    id: saved.id,
    name: saved.name,
    rev: saved.rev,
    updatedAt: saved.updatedAt,
    hasOgs: saved.hasOgs,
    hasZip: saved.hasZip,
    volkSources: saved.volkSources ?? collectVolkSources(snapshot),
  };
}

/**
 * S2-nuvem: open a cloud project. Prefers signed `downloadOgsUrl` capability
 * URLs (no credentials), falling back to inline `ogs`.
 */
export async function openProjectFromCloud(id: string): Promise<{ project: Project; rev: number }> {
  const data = await gqlRequest<{ ografProject: ApiOpenRow | null }>(
    OGRAF_OPEN_QUERY,
    { accID: getSouvAccID(), id },
    'open',
  );
  const row = data.ografProject;
  if (!row) throw new Error('Cloud project not found.');
  // Fail closed: the next save sends this back as `expectedRev`, so a missing
  // rev must surface now instead of causing a spurious conflict later.
  if (typeof row.rev !== 'number') {
    throw new Error(
      `Cloud project "${row.name}" came back without a revision. Reload the list and try again.`,
    );
  }
  const rev = row.rev;
  if (row.downloadOgsUrl) return { project: await openProjectFromUrl(row.downloadOgsUrl), rev };
  if (row.ogs) return { project: row.ogs, rev };
  throw new Error('The cloud project has no editable source. Publish it with `.ogs` first.');
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /already published with different content/i.test(error.message);
}

/** Bumps the last numeric segment (`1.1.0` -> `1.1.1`); null when not numeric. */
function bumpPatchVersion(version: string): string | null {
  const match = /^(\d+(?:\.\d+)*)$/.exec(version.trim());
  const digits = match?.[1];
  if (!digits) return null;
  const parts = digits.split('.');
  const last = parts.length - 1;
  parts[last] = String(Number(parts[last]) + 1);
  return parts.join('.');
}

/**
 * E1-nuvem: export with the same certified pipeline as local `Export .ograf.zip`,
 * then upload the resulting bytes to the Souv cloud. Requires login.
 * Returns the file name the user would have downloaded locally, plus the
 * published manifest version (which may have been auto-bumped, see below).
 */
export async function exportProjectToCloud(
  project: Project,
  compositionId?: string,
  options: { expectedRev?: number } = {},
): Promise<{ fileName: string; bytes: number; version: string }> {
  const buildAndPublish = async (
    candidate: Project,
  ): Promise<{ fileName: string; bytes: number }> => {
    const composition =
      candidate.compositions.find(
        (item) => item.id === (compositionId ?? candidate.mainCompositionId),
      ) ?? candidate.compositions[0];
    if (!composition) throw new Error('The project has no composition to export.');

    // Produce the zip in memory WITHOUT triggering the local save/download dialog,
    // using the same certified builder as local `Export .ograf.zip` (dual profile,
    // matching the preview panel default) so both flows stay byte-identical.
    const { blob, fileName, artifacts } = await buildCertifiedZip(
      candidate,
      composition,
      getExportProfile('dual'),
    );
    ensureSizeOk(blob.size, 'The exported package');
    const zipBase64 = await blobToBase64(blob);

    try {
      await gqlRequest(
        OGRAF_PUBLISH_MUTATION,
        {
          accID: getSouvAccID(),
          id: candidate.id,
          content: {
            zipBase64,
            name: candidate.name,
            fileName,
            manifest: artifacts.manifest,
            volkSources: collectVolkSources(candidate).slice(0, 100),
            ...(options.expectedRev !== undefined ? { expectedRev: options.expectedRev } : {}),
          },
        },
        'publish',
      );
    } catch (error) {
      if (isRevConflict(error))
        await throwRevConflict(candidate.id, error as Error, getSouvAccID());
      throw error;
    }
    return { fileName, bytes: blob.size };
  };

  try {
    const result = await buildAndPublish(project);
    return { ...result, version: project.version };
  } catch (error) {
    if (!isVersionConflict(error)) throw error;
    // The backend keeps published versions immutable: same manifest version
    // with different bytes is rejected. Bump the patch version, recertify
    // (the manifest embeds the version) and publish once more. The caller
    // persists the returned version so the next export starts from it.
    const bumped = bumpPatchVersion(project.version);
    if (!bumped) {
      throw new Error(
        `Version ${project.version} of this graphic is already published with different content. Bump the version in project settings and export again.`,
        { cause: error },
      );
    }
    const retryProject = JSON.parse(JSON.stringify(project)) as Project;
    retryProject.version = bumped;
    const result = await buildAndPublish(retryProject);
    return { ...result, version: bumped };
  }
}

/**
 * S2-nuvem: delete a cloud project (`.ogs`/`.zip`/thumb + D1 row, owner only).
 * Requires login + explicit user confirm at the call site. A `false`/null
 * answer (or GraphQL error) throws instead of pretending the row is gone.
 */
export async function deleteCloudProject(id: string): Promise<void> {
  const data = await gqlRequest<{ ografProjectDelete: boolean | null }>(
    OGRAF_DELETE_MUTATION,
    { accID: getSouvAccID(), id },
    'delete',
  );
  if (data.ografProjectDelete !== true) {
    throw new Error('The Souv cloud did not confirm the deletion. Try again.');
  }
}

/**
 * S2-nuvem: rename a cloud project via the native `ografProjectRename`
 * mutation (D1 name update only — no `.ogs` roundtrip, works with or without
 * an editable source). The backend trims and caps the name at 200 chars.
 */
export async function renameCloudProject(
  row: CloudProjectSummary,
  newName: string,
): Promise<CloudProjectSummary> {
  const name = newName.trim();
  if (!name) throw new Error('The project name cannot be empty.');
  if (name.length > 200) throw new Error('The project name is too long (max 200 characters).');
  if (name === row.name) return row;
  const data = await gqlRequest<{
    ografProjectRename: {
      id: string;
      name: string;
      rev: number;
      hasOgs: boolean;
      hasZip: boolean;
      updatedAt: string;
      volkSources?: string[];
    };
  }>(
    `mutation OgrafRename($id: ID!, $name: String!, $accID: ID) {
      ografProjectRename(accID: $accID, id: $id, name: $name) {
        id name rev hasOgs hasZip updatedAt volkSources
      }
    }`,
    { accID: getSouvAccID(), id: row.id, name },
    'rename',
  );
  const saved = data.ografProjectRename;
  if (typeof saved.rev !== 'number') {
    throw new Error('The Souv cloud did not confirm the rename. Try again.');
  }
  return {
    id: saved.id,
    name: saved.name,
    rev: saved.rev,
    updatedAt: saved.updatedAt,
    hasOgs: saved.hasOgs,
    hasZip: saved.hasZip,
    volkSources: saved.volkSources ?? row.volkSources,
  };
}

/**
 * S2-nuvem: download the published `.ograf.zip` of a cloud project.
 * Uses the signed `downloadZipUrl` capability (no credentials needed).
 */
export async function downloadCloudZip(row: CloudProjectSummary): Promise<void> {
  if (!row.hasZip) {
    throw new Error(
      'This project has no published package yet. Export it to the Souv cloud first.',
    );
  }
  const data = await gqlRequest<{
    ografProject: { name: string; downloadZipUrl?: string | null } | null;
  }>(
    `query OgrafZip($id: ID!, $accID: ID) { ografProject(accID: $accID, id: $id) { name downloadZipUrl } }`,
    { accID: getSouvAccID(), id: row.id },
    'read download link',
  );
  const url = data.ografProject?.downloadZipUrl;
  if (!url) {
    throw new Error(
      'This project has no published package yet. Export it to the Souv cloud first.',
    );
  }
  let blob: Blob;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch {
    throw new Error('Could not download the published package. Check the network connection.');
  }
  const safe = (data.ografProject?.name ?? row.name).replace(/[\\/:*?"<>|]/g, '_').trim();
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${safe || 'project'}.ograf.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
}

export interface CloudAccount {
  id: string;
  title: string;
  /** True for the login's own (personal) account. */
  isMe: boolean;
  /** False when this account grants no `visao` write (saves will fail high). */
  canWrite: boolean;
}

/**
 * Lists every Souv account the login can access (personal first, then
 * invited). Requires login. If a previously selected account is gone
 * (invite revoked), the selection falls back to personal.
 */
export async function listSouvAccounts(): Promise<CloudAccount[]> {
  const data = await gqlRequest<{
    userMe?: { id?: string | null } | null;
    userAccounts: Array<{
      id: string;
      title?: string | null;
      isMe?: boolean | null;
      avatar?: string | null;
      permission?: { visaoEffective?: { canWrite?: boolean | null } | null } | null;
    }> | null;
  }>(
    `query SouvAccounts {
      userMe { id }
      userAccounts(withMe: true) {
        id title isMe
        permission { visaoEffective { canWrite } }
      }
    }`,
    {},
    'list accounts',
  );
  // NOTE: the backend's `isMe` flag is unreliable — it is computed from the
  // member row's JSON, whose `id` is the member user (not the account), so
  // it comes back true for invited accounts too. The personal account is
  // the one whose id IS the login user, so derive `isMe` from `userMe`.
  const meID = data.userMe?.id ?? null;
  const accounts = (data.userAccounts ?? []).map((entry, index) => ({
    id: entry.id,
    title: entry.title?.trim() ? entry.title : entry.id,
    // Fallback when userMe is unavailable: the backend always lists the
    // personal account first (withMe prepends it).
    isMe: meID ? entry.id === meID : index === 0,
    canWrite: entry.permission?.visaoEffective?.canWrite === true,
  }));
  const selected = getSouvAccID();
  const selectedAccount = selected
    ? accounts.find((account) => account.id === selected)
    : undefined;
  if (selected && !selectedAccount) {
    // Invite revoked (or account gone): fall back to personal.
    setSouvAccID(null);
  } else if (selectedAccount) {
    // Keep the stored display title in sync (account renamed in Souv) —
    // silently: the account did not change, so no listener reloads lists.
    syncSouvAccTitle(selectedAccount.title);
  }
  return accounts;
}

/**
 * S2-nuvem: copy a project (editable source + published package, when any)
 * into another account the login can access. Reads from the currently
 * selected account, writes to `targetAccID`.
 *
 * The copy gets a NEW project id: the backend's `ograf_projects.id` is a
 * GLOBAL primary key (not owner-scoped), so reusing the source id collides
 * with the source row itself and the upsert fails as "Concurrent save
 * detected" even when the target account has never seen the project.
 * For the same reason the published package is rebuilt + recertified from
 * the copied source (its manifest carries the new id) instead of reusing
 * the source zip bytes. Re-running a copy creates another copy.
 */
export async function copyCloudProjectToAccount(
  row: CloudProjectSummary,
  targetAccID: string,
): Promise<CloudProjectSummary> {
  if (!targetAccID || targetAccID === getSouvAccID()) {
    throw new Error('Pick a different account as the copy destination.');
  }
  if (!row.hasOgs) {
    throw new Error('Only projects with an editable source can be copied.');
  }
  // Source lives in the currently selected account.
  const data = await gqlRequest<{ ografProject: ApiOpenRow | null }>(
    OGRAF_OPEN_QUERY,
    { accID: getSouvAccID(), id: row.id },
    'open',
  );
  const source = data.ografProject;
  if (!source?.ogs) throw new Error('The cloud project has no editable source to copy.');
  const project = source.ogs;
  project.name = source.name;
  project.id = createId('project');

  // 1) Editable source + thumbnail into the destination account (new id).
  const saved = await saveProjectToCloud(project, { accID: targetAccID });

  // 2) Published package, when the source has one: rebuild + recertify from
  // the copied source so the manifest carries the new id, then publish it
  // under the destination account.
  if (row.hasZip) {
    try {
      const composition =
        project.compositions.find((item) => item.id === project.mainCompositionId) ??
        project.compositions[0];
      if (!composition) throw new Error('The project has no composition to copy.');
      const { blob, fileName, artifacts } = await buildCertifiedZip(
        project,
        composition,
        getExportProfile('dual'),
      );
      ensureSizeOk(blob.size, 'The exported package');
      const zipBase64 = await blobToBase64(blob);
      await gqlRequest(
        OGRAF_PUBLISH_MUTATION,
        {
          accID: targetAccID,
          id: project.id,
          content: {
            zipBase64,
            name: project.name,
            fileName,
            manifest: artifacts.manifest,
            volkSources: collectVolkSources(project).slice(0, 100),
            expectedRev: saved.rev,
          },
        },
        'publish',
      );
    } catch (error) {
      // The source copy already landed in the destination account. Say so,
      // or a blind retry piles up duplicate copies (each attempt is a new id).
      throw new Error(
        `The source was copied to the other account as "${saved.name}", but publishing its package failed: ${
          error instanceof Error ? error.message : 'unknown error'
        } Delete that partial copy before copying again to avoid duplicates.`,
        { cause: error },
      );
    }
  }

  return saved;
}
