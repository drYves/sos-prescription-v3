import type { LocalUpload } from '../formTunnel/types';

export function toPatientSafeArtifactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '');
  const message = raw.trim().toLowerCase();

  if (!message) {
    return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
  }

  if (
    message.includes('upload')
    || message.includes('ticket')
    || message.includes('artefact')
    || message.includes('cors')
  ) {
    return 'Le document n’a pas pu être envoyé. Merci de réessayer.';
  }

  if (
    message.includes('lecture')
    || message.includes('analyse')
    || message.includes('document')
    || message.includes('prescription')
    || message.includes('expir')
  ) {
    return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
  }

  return 'Lecture du document impossible. Merci de réessayer avec un document plus lisible.';
}

export function mergeRejectedFiles(current: File[], incoming: File[]): File[] {
  const next = Array.isArray(current) ? current.slice() : [];
  const seen = new Set(next.map((file) => `${file.name}::${file.size}::${file.lastModified}`));

  for (const file of Array.isArray(incoming) ? incoming : []) {
    const key = `${file.name}::${file.size}::${file.lastModified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(file);
  }

  return next;
}

export function createLocalUpload(file: File): LocalUpload {
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    file,
    original_name: file?.name ? String(file.name) : 'upload.bin',
    mime: file?.type ? String(file.type) : 'application/octet-stream',
    mime_type: file?.type ? String(file.type) : 'application/octet-stream',
    size_bytes: typeof file?.size === 'number' ? file.size : 0,
    kind: 'PROOF',
    status: 'QUEUED',
  };
}

export function isResyncableLocalUpload(entry: LocalUpload): boolean {
  return entry.file instanceof File && Number(entry.file.size || 0) > 0;
}
