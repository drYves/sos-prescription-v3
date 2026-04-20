import { useCallback } from 'react';
import type {
  DraftSaveResponse,
  LocalUpload,
  StoredDraftPayload,
  UploadedArtifact,
} from './types';

export type DraftArtifactUploadResult = {
  entry: LocalUpload;
  uploadedArtifact?: UploadedArtifact;
  error?: unknown;
};

type DraftNetworkDeps = {
  loadSubmissionDraftApi: (submissionRef: string) => Promise<StoredDraftPayload>;
  saveSubmissionDraftApi: (payload: Record<string, unknown>) => Promise<DraftSaveResponse>;
  directSubmissionArtifactUpload: (file: File, submissionRef: string, kind?: 'PROOF') => Promise<UploadedArtifact>;
};

type DraftArtifactProcessedCallback = (result: DraftArtifactUploadResult) => void | Promise<void>;

export function useDraftNetwork(input: DraftNetworkDeps) {
  const { loadSubmissionDraftApi, saveSubmissionDraftApi, directSubmissionArtifactUpload } = input;

  const loadSubmissionDraft = useCallback((submissionRef: string) => (
    loadSubmissionDraftApi(submissionRef)
  ), [loadSubmissionDraftApi]);

  const saveSubmissionDraft = useCallback((payload: Record<string, unknown>) => (
    saveSubmissionDraftApi(payload)
  ), [saveSubmissionDraftApi]);

  const uploadDraftArtifacts = useCallback(async (
    entries: LocalUpload[],
    submissionRef: string,
    onProcessed?: DraftArtifactProcessedCallback,
  ): Promise<DraftArtifactUploadResult[]> => {
    const results: DraftArtifactUploadResult[] = [];

    for (const entry of entries) {
      let result: DraftArtifactUploadResult;

      try {
        const uploadedArtifact = await directSubmissionArtifactUpload(entry.file, submissionRef, 'PROOF');
        result = {
          entry,
          uploadedArtifact,
        };
      } catch (error) {
        result = {
          entry,
          error,
        };
      }

      results.push(result);

      if (onProcessed) {
        await onProcessed(result);
      }
    }

    return results;
  }, [directSubmissionArtifactUpload]);

  return {
    loadSubmissionDraft,
    saveSubmissionDraft,
    uploadDraftArtifacts,
  };
}
