import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  ArtifactAnalysis,
  FlowType,
  LocalUpload,
  MedicationItem,
  SubmissionRefState,
} from '../formTunnel/types';
import {
  createLocalUpload,
  isResyncableLocalUpload,
  mergeRejectedFiles,
  toPatientSafeArtifactErrorMessage,
} from './helpers';

export type IntakeUploadResult = {
  entry: LocalUpload;
  analysis?: ArtifactAnalysis;
  error?: unknown;
};

type IntakeProcessedCallback = (result: IntakeUploadResult) => void | Promise<void>;

type UseIntakeInput = {
  flow: FlowType | null;
  isLoggedIn: boolean;
  files: LocalUpload[];
  resumedDraftRef: string | null;
  submissionRefStateRef: MutableRefObject<SubmissionRefState>;
  artifactResyncFileIdsRef: MutableRefObject<string[]>;
  setFiles: Dispatch<SetStateAction<LocalUpload[]>>;
  setItems: Dispatch<SetStateAction<MedicationItem[]>>;
  setRejectedFiles: Dispatch<SetStateAction<File[]>>;
  setAnalysisInProgress: Dispatch<SetStateAction<boolean>>;
  setAnalysisMessage: Dispatch<SetStateAction<string | null>>;
  setSubmitError: Dispatch<SetStateAction<string | null>>;
  setResumedDraftRef: Dispatch<SetStateAction<string | null>>;
  invalidatePreparedSubmission: () => void;
  ensureSubmissionRef: () => Promise<string>;
  uploadIntakeFiles: (
    entries: LocalUpload[],
    submissionRef: string,
    onProcessed?: IntakeProcessedCallback,
  ) => Promise<IntakeUploadResult[]>;
  toPatientSafeSubmissionErrorMessage: (error: unknown) => string;
  resolveAnalyzedItems: (analysis: ArtifactAnalysis | null | undefined) => MedicationItem[];
  mergeMedicationItems: (current: MedicationItem[], incoming: MedicationItem[]) => MedicationItem[];
};

export function useIntake(input: UseIntakeInput) {
  const {
    flow,
    isLoggedIn,
    files,
    resumedDraftRef,
    submissionRefStateRef,
    artifactResyncFileIdsRef,
    setFiles,
    setItems,
    setRejectedFiles,
    setAnalysisInProgress,
    setAnalysisMessage,
    setSubmitError,
    setResumedDraftRef,
    invalidatePreparedSubmission,
    ensureSubmissionRef,
    uploadIntakeFiles,
    toPatientSafeSubmissionErrorMessage,
    resolveAnalyzedItems,
    mergeMedicationItems,
  } = input;

  const intakeAsyncStateRef = useRef<{ version: number; pending: number }>({ version: 0, pending: 0 });

  const invalidateAsyncContext = useCallback(() => {
    intakeAsyncStateRef.current = {
      version: intakeAsyncStateRef.current.version + 1,
      pending: 0,
    };
    setAnalysisInProgress(false);
  }, [setAnalysisInProgress]);

  const handleFilesSelected = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0 || flow !== 'ro_proof') {
      return;
    }

    const nextUploads = Array.from(list).map(createLocalUpload);
    if (nextUploads.length === 0) {
      return;
    }

    invalidatePreparedSubmission();
    setSubmitError(null);
    setRejectedFiles([]);
    setAnalysisMessage(null);
    setFiles((current) => [...current, ...nextUploads]);

    if (!isLoggedIn) {
      setAnalysisInProgress(false);
      setAnalysisMessage('Les documents seront joints à votre dossier après validation de votre adresse.');
      return;
    }

    const intakeContextVersion = intakeAsyncStateRef.current.version;
    intakeAsyncStateRef.current = {
      version: intakeContextVersion,
      pending: intakeAsyncStateRef.current.pending + 1,
    };
    setAnalysisInProgress(true);

    const rejected: File[] = [];
    let firstError: string | null = null;
    let mergedInfo = false;

    try {
      const submissionRef = await ensureSubmissionRef();

      // Repli sécurisé : les mutations UI par fichier restent locales pour préserver le timing READY / erreur.
      await uploadIntakeFiles(nextUploads, submissionRef, (result) => {
        if (intakeAsyncStateRef.current.version !== intakeContextVersion) {
          return;
        }

        if (result.error) {
          rejected.push(result.entry.file);
          if (!firstError) {
            firstError = toPatientSafeArtifactErrorMessage(result.error);
          }
          return;
        }

        const analysis = result.analysis;
        const aiItems = resolveAnalyzedItems(analysis);

        if (Boolean(analysis && analysis.ok === false) || aiItems.length < 1) {
          rejected.push(result.entry.file);
          if (!firstError) {
            firstError = toPatientSafeArtifactErrorMessage(
              typeof analysis?.message === 'string' && analysis.message.trim() !== ''
                ? new Error(analysis.message.trim())
                : new Error('Lecture du document impossible.'),
            );
          }
          return;
        }

        mergedInfo = true;
        setItems((current) => mergeMedicationItems(current, aiItems));
        setFiles((current) => current.map((file) => (
          file.id === result.entry.id
            ? {
              ...file,
              status: 'READY',
            }
            : file
        )));
      });

      if (intakeAsyncStateRef.current.version !== intakeContextVersion) {
        return;
      }

      setRejectedFiles((current) => mergeRejectedFiles(current, rejected));
      if (mergedInfo) {
        setAnalysisMessage('Traitement détecté et pré-rempli.');
      } else {
        setAnalysisMessage(null);
      }

      if (firstError) {
        setSubmitError(firstError);
      }
    } catch (error) {
      if (intakeAsyncStateRef.current.version !== intakeContextVersion) {
        return;
      }

      setRejectedFiles((current) => mergeRejectedFiles(current, nextUploads.map((entry) => entry.file)));
      setAnalysisMessage(null);
      const message = toPatientSafeSubmissionErrorMessage(error);
      setSubmitError(
        message.includes('connecter')
          ? message
          : 'Nous n’avons pas pu enregistrer votre document pour le moment. Merci de réessayer.',
      );
    } finally {
      if (intakeAsyncStateRef.current.version === intakeContextVersion) {
        const nextPending = Math.max(0, intakeAsyncStateRef.current.pending - 1);
        intakeAsyncStateRef.current = {
          version: intakeContextVersion,
          pending: nextPending,
        };
        if (nextPending === 0) {
          setAnalysisInProgress(false);
        }
      }
    }
  }, [
    ensureSubmissionRef,
    flow,
    invalidatePreparedSubmission,
    isLoggedIn,
    mergeMedicationItems,
    resolveAnalyzedItems,
    setAnalysisInProgress,
    setAnalysisMessage,
    setFiles,
    setItems,
    setRejectedFiles,
    setSubmitError,
    toPatientSafeSubmissionErrorMessage,
    uploadIntakeFiles,
  ]);

  const handleRemoveFile = useCallback((fileId: string) => {
    invalidatePreparedSubmission();
    invalidateAsyncContext();
    setSubmitError(null);

    const remainingFiles = files.filter((entry) => entry.id !== fileId);
    const shouldInvalidateSubmissionCache = Boolean(String(submissionRefStateRef.current.ref || '').trim())
      || artifactResyncFileIdsRef.current.length > 0
      || Boolean(resumedDraftRef);

    if (!shouldInvalidateSubmissionCache) {
      setFiles(remainingFiles);
      return;
    }

    const uploadableRemainingFiles = remainingFiles.filter((entry) => isResyncableLocalUpload(entry));
    artifactResyncFileIdsRef.current = uploadableRemainingFiles.map((entry) => entry.id);
    submissionRefStateRef.current = { ref: null };
    setResumedDraftRef(null);
    setAnalysisMessage(null);
    setRejectedFiles([]);
    setFiles(uploadableRemainingFiles);
  }, [
    artifactResyncFileIdsRef,
    files,
    invalidateAsyncContext,
    invalidatePreparedSubmission,
    resumedDraftRef,
    setAnalysisMessage,
    setFiles,
    setRejectedFiles,
    setResumedDraftRef,
    setSubmitError,
    submissionRefStateRef,
  ]);

  return {
    handleFilesSelected,
    handleRemoveFile,
    invalidateAsyncContext,
  };
}
