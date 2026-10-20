import JSZip from 'jszip';
import type { Composition, Project } from '@ograf-editor/scene-model';
import { withExportThumbnail, type ExportProfile } from '@ograf-editor/codegen';
import { saveBlobToFile } from './fileIO';
import {
  buildExportArtifacts,
  certifyExportArtifacts,
  type ExportArtifacts,
  type OGrafCompatibilityResult,
} from './ografCompatibility';

export { buildExportArtifacts } from './ografCompatibility';

const ZIP_FILE_TYPES = [
  { description: 'OGraf Package', accept: { 'application/zip': ['.ograf.zip'] } },
];

export type ExportZipResult = ExportArtifacts & {
  compatibility: OGrafCompatibilityResult;
  saveResult: 'saved' | 'cancelled' | 'downloaded';
};

export interface CertifiedZipPackage {
  blob: Blob;
  fileName: string;
  artifacts: ExportArtifacts;
  compatibility: OGrafCompatibilityResult;
}

/** Reads a Blob fully as a base64 (no data-URI prefix) string. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Packages an OGraf-certified project as an in-memory `.ograf.zip` Blob WITHOUT
 * triggering any local save/download dialog. Shared by local `Export .ograf.zip`
 * and cloud publish so both flows produce byte-identical packages.
 */
export async function buildCertifiedZip(
  project: Project,
  composition: Composition,
  profile?: ExportProfile,
): Promise<CertifiedZipPackage> {
  const snapshot = structuredClone(project);
  const snapshotComposition = structuredClone(composition);
  let artifacts = buildExportArtifacts(snapshot, snapshotComposition, profile);
  if (artifacts.valid) {
    const { createTemplateThumbnail } = await import('./templateThumbnail');
    const thumbnail = await createTemplateThumbnail({
      ...snapshot,
      mainCompositionId: snapshotComposition.id,
      compositions: [snapshotComposition],
    });
    const bytes = new Uint8Array(await thumbnail.arrayBuffer());
    const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
    artifacts = withExportThumbnail(artifacts, snapshot, base64);
  }
  const compatibility = await certifyExportArtifacts(artifacts);
  if (!compatibility.valid) {
    throw new Error(
      `Export blocked by OGraf compatibility gate: ${compatibility.errors.join(' ')}`,
    );
  }
  const zip = new JSZip();
  zip.file(artifacts.manifestFileName, JSON.stringify(artifacts.manifest, null, 2));
  zip.file('main.js', artifacts.mainJs);
  for (const resource of artifacts.resources) {
    zip.file(resource.path, resource.data, { base64: resource.base64 });
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const fileName = `${snapshot.name || 'untitled'}${profile?.fileNameSuffix ?? ''}.ograf.zip`;
  return { blob, fileName, artifacts, compatibility };
}

/** Packages only an OGraf-certified project; no save/download starts before all checks pass. */
export async function exportProjectAsZip(
  project: Project,
  composition: Composition,
  profile?: ExportProfile,
): Promise<ExportZipResult> {
  const { blob, fileName, artifacts, compatibility } = await buildCertifiedZip(
    project,
    composition,
    profile,
  );
  const saveResult = await saveBlobToFile(blob, fileName, ZIP_FILE_TYPES);
  return { ...artifacts, compatibility, saveResult };
}
