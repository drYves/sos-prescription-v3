import { useCallback } from 'react';
import type {
  ArtifactAnalysis,
  LocalUpload,
  SubmissionInitResponse,
  UploadedArtifact,
} from './types';

export type IntakeFileUploadResult = {
  entry: LocalUpload;
  uploadedArtifact?: UploadedArtifact;
  analysis?: ArtifactAnalysis;
  error?: unknown;
};

type SubmissionNetworkDeps = {
  createSubmissionApi: (payload: Record<string, unknown>) => Promise<SubmissionInitResponse>;
  directSubmissionArtifactUpload: (file: File, submissionRef: string, kind?: 'PROOF') => Promise<UploadedArtifact>;
  analyzeArtifactApi: (artifactId: string) => Promise<ArtifactAnalysis>;
  finalizeSubmissionApi: (submissionRef: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type IntakeFileProcessedCallback = (result: IntakeFileUploadResult) => void | Promise<void>;

export function useSubmissionNetwork(input: SubmissionNetworkDeps) {
  const {
    createSubmissionApi,
    directSubmissionArtifactUpload,
    analyzeArtifactApi,
    finalizeSubmissionApi,
  } = input;

  const createSubmission = useCallback((payload: Record<string, unknown>) => (
    createSubmissionApi(payload)
  ), [createSubmissionApi]);

  const uploadIntakeFiles = useCallback(async (
    entries: LocalUpload[],
    submissionRef: string,
    onProcessed?: IntakeFileProcessedCallback,
  ): Promise<IntakeFileUploadResult[]> => {
    const results: IntakeFileUploadResult[] = [];

    for (const entry of entries) {
      let result: IntakeFileUploadResult;

      try {
        const uploadedArtifact = await directSubmissionArtifactUpload(entry.file, submissionRef, 'PROOF');
        const analysis = await analyzeArtifactApi(uploadedArtifact.id);
        result = {
          entry,
          uploadedArtifact,
          analysis,
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
  }, [analyzeArtifactApi, directSubmissionArtifactUpload]);

  const finalizeSubmission = useCallback((submissionRef: string, payload: Record<string, unknown>) => (
    finalizeSubmissionApi(submissionRef, payload)
  ), [finalizeSubmissionApi]);

  return {
    createSubmission,
    uploadIntakeFiles,
    finalizeSubmission,
  };
}
