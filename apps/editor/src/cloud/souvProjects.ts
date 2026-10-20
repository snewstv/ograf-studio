/**
 * Cloud project storage against the Souv API (matrix S1/S2/E1-nuvem).
 *
 * Payloads reuse the exact local serializations so cloud and disk stay
 * byte-compatible: `.ogs` is the same JSON as `Save Project`, and the published
 * `.ograf.zip` is produced by the same `exportProjectAsZip` + certification gate.
 * `v_volk` bindings travel inside the project JSON untouched.
 */

import type { Project } from '@ograf-editor/scene-model';
import { templateThumbnailName } from '@ograf-editor/scene-model';
import { getExportProfile } from '@ograf-editor/codegen';
import { openProjectFromUrl } from '../state/fileIO';
import { blobToBase64, buildCertifiedZip } from '../state/exportPackage';
import { createTemplateThumbnail } from '../state/templateThumbnail';
import { clearSouvToken, requireSouvLogin, souvFetch } from './souvAuth';

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
  volkSources: string[];
  downloadOgsUrl?: string | null;
  downloadZipUrl?: string | null;
}

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

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? text.slice(0, 300);
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** S2-nuvem: list the signed-in user's cloud projects. Requires login. */
export async function listCloudProjects(): Promise<CloudProjectSummary[]> {
  await requireSouvLogin();
  const response = await souvFetch('/api/ograf/projects');
  if (response.status === 401) {
    clearSouvToken();
    throw new Error('Your Souv session expired. Log in again to list cloud projects.');
  }
  if (!response.ok) throw new Error(`Could not list cloud projects: ${await readError(response)}`);
  const rows = (await response.json()) as ApiProjectRow[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    rev: typeof row.rev === 'number' ? row.rev : 0,
    updatedAt: row.updatedAt,
    hasOgs: row.hasOgs,
    hasZip: row.hasZip,
    volkSources: row.volkSources ?? [],
  }));
}

/** S1-nuvem: save editable `.ogs` source + thumbnail to the Souv cloud. Requires login. */
export async function saveProjectToCloud(
  project: Project,
  options: { expectedRev?: number } = {},
): Promise<CloudProjectSummary> {
  await requireSouvLogin();
  const snapshot = JSON.parse(JSON.stringify(project)) as Project;
  const ogsText = JSON.stringify(snapshot, null, 2);
  ensureSizeOk(new TextEncoder().encode(ogsText).byteLength, 'The editable project source');

  const thumbnail = await createTemplateThumbnail(snapshot);
  const thumbBuffer = new Uint8Array(await thumbnail.arrayBuffer());
  let thumbBinary = '';
  for (let i = 0; i < thumbBuffer.length; i++) thumbBinary += String.fromCharCode(thumbBuffer[i]!);
  const thumbDataUri = `data:${thumbnail.type || 'image/png'};base64,${btoa(thumbBinary)}`;

  const response = await souvFetch(`/api/ograf/projects/${encodeURIComponent(snapshot.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: snapshot.name,
      ogs: snapshot,
      thumbDataUri,
      thumbName: templateThumbnailName(snapshot),
      volkSources: collectVolkSources(snapshot),
      ...(options.expectedRev !== undefined ? { expectedRev: options.expectedRev } : {}),
    }),
  });
  if (response.status === 401) {
    clearSouvToken();
    throw new Error('Your Souv session expired. Log in again to save to the cloud.');
  }
  if (response.status === 409) {
    throw new Error(await readError(response));
  }
  if (!response.ok) throw new Error(`Cloud save failed: ${await readError(response)}`);
  return (await response.json()) as CloudProjectSummary;
}

/**
 * S2-nuvem: open a cloud project. Prefers the signed `downloadOgsUrl` (loaded via the
 * existing credential-free `openProjectFromUrl` path), falling back to inline JSON.
 */
export async function openProjectFromCloud(id: string): Promise<{ project: Project; rev: number }> {
  await requireSouvLogin();
  const response = await souvFetch(`/api/ograf/projects/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Could not open cloud project: ${await readError(response)}`);
  const row = (await response.json()) as ApiProjectRow & { ogs?: Project | null };
  const rev = typeof row.rev === 'number' ? row.rev : 0;
  if (row.downloadOgsUrl) return { project: await openProjectFromUrl(row.downloadOgsUrl), rev };
  if (row.ogs) return { project: row.ogs, rev };
  throw new Error('The cloud project has no editable source. Publish it with `.ogs` first.');
}

/**
 * E1-nuvem: export with the same certified pipeline as local `Export .ograf.zip`,
 * then upload the resulting bytes to the Souv cloud. Requires login.
 * Returns the file name the user would have downloaded locally.
 */
export async function exportProjectToCloud(
  project: Project,
  compositionId?: string,
  options: { expectedRev?: number } = {},
): Promise<{ fileName: string; bytes: number }> {
  await requireSouvLogin();
  const composition =
    project.compositions.find((item) => item.id === (compositionId ?? project.mainCompositionId)) ??
    project.compositions[0];
  if (!composition) throw new Error('The project has no composition to export.');

  // Produce the zip in memory WITHOUT triggering the local save/download dialog,
  // using the same certified builder as local `Export .ograf.zip` (dual profile,
  // matching the preview panel default) so both flows stay byte-identical.
  const { blob, fileName, artifacts } = await buildCertifiedZip(
    project,
    composition,
    getExportProfile('dual'),
  );
  ensureSizeOk(blob.size, 'The exported package');
  const zipBase64 = await blobToBase64(blob);

  const response = await souvFetch(
    `/api/ograf/projects/${encodeURIComponent(project.id)}/publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: project.name,
        zipBase64,
        fileName,
        manifest: artifacts.manifest,
        volkSources: collectVolkSources(project),
        ...(options.expectedRev !== undefined ? { expectedRev: options.expectedRev } : {}),
      }),
    },
  );
  if (response.status === 409) {
    throw new Error(await readError(response));
  }
  if (!response.ok) throw new Error(`Cloud publish failed: ${await readError(response)}`);
  return { fileName, bytes: blob.size };
}
