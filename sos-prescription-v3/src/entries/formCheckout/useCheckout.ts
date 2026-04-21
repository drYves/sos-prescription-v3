import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import {
  type StripePaymentIntentPayload,
  type StripePaymentModuleProps,
  type StripePaymentResolutionMeta,
  toMedicalGradePaymentErrorMessage,
} from '../../components/payment/StripePaymentModule';
import { buildFinalizePayload } from '../formTunnel/builders';
import type {
  ClinicalState,
  FlowType,
  LocalUpload,
  Stage,
  SubmissionRefState,
  SubmissionResult,
  WorkflowState,
} from '../formTunnel/types';
import { isResyncableLocalUpload } from '../formIntake/helpers';
import type {
  CheckoutPaymentSectionProps,
  CheckoutPrioritySectionProps,
} from './CheckoutSection';
import { describePriorityTurnaround } from './helpers';

type SubmitBlockInfo = {
  ok: boolean;
  reasons: Array<{ code: string; message: string }>;
  code: string | null;
  message: string | null;
};

type UploadDraftArtifactResult = {
  entry: LocalUpload;
  error?: unknown;
};

type CheckoutConfigSnapshot = {
  currentUser?: {
    email?: string;
  };
  patientProfile?: {
    fullname?: string;
  };
};

type FrontendLogLevel = 'debug' | 'info' | 'warning' | 'error';

type UseCheckoutOptions = {
  config: CheckoutConfigSnapshot;
  clinicalState: ClinicalState;
  workflowState: WorkflowState;
  pricingLoading: boolean;
  submitLoading: boolean;
  isLoggedIn: boolean;
  isDraftMode: boolean;
  submitBlockInfo: SubmitBlockInfo;
  consentRequired: boolean;
  cguVersion?: string;
  privacyVersion?: string;
  submissionRefStateRef: MutableRefObject<SubmissionRefState>;
  artifactResyncFileIdsRef: MutableRefObject<string[]>;
  setPriority: Dispatch<SetStateAction<'standard' | 'express'>>;
  setStage: Dispatch<SetStateAction<Stage>>;
  setSubmitError: Dispatch<SetStateAction<string | null>>;
  setSubmitLoading: Dispatch<SetStateAction<boolean>>;
  setPreparedSubmission: Dispatch<SetStateAction<SubmissionResult | null>>;
  setSubmissionResult: Dispatch<SetStateAction<SubmissionResult | null>>;
  setFiles: Dispatch<SetStateAction<LocalUpload[]>>;
  ensureSubmissionRef: () => Promise<string>;
  uploadDraftArtifacts: (
    entries: LocalUpload[],
    submissionRef: string,
    onResult: (result: UploadDraftArtifactResult) => void,
  ) => Promise<UploadDraftArtifactResult[]>;
  finalizeSubmission: (submissionRef: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  createPaymentIntent: (id: number, priority: 'standard' | 'express') => Promise<StripePaymentIntentPayload>;
  confirmPaymentIntent: (id: number, paymentIntentId: string) => Promise<unknown>;
  frontendLog: (event: string, level?: FrontendLogLevel, meta?: Record<string, unknown>) => void;
  toPatientSafeSubmissionErrorMessage: (error: unknown) => string;
  safePatientNameValue: (value: unknown) => string;
  splitPatientNameValue: (value: unknown) => { firstName: string; lastName: string };
};

type StripeTunnelProps = Pick<
  StripePaymentModuleProps,
  | 'billingName'
  | 'billingEmail'
  | 'fallbackPublishableKey'
  | 'prerequisiteError'
  | 'createIntent'
  | 'confirmIntent'
  | 'onAuthorized'
  | 'onAuthorizedState'
  | 'onErrorState'
  | 'safeErrorMessage'
>;

type UseCheckoutResult = {
  selectedAmount: number | null;
  selectedPriorityEta: string;
  invalidatePreparedSubmission: () => void;
  handlePriorityChange: (nextPriority: 'standard' | 'express') => void;
  prepareSubmissionForPayment: () => Promise<SubmissionResult | null>;
  handleContinueToPaymentAuth: () => Promise<void>;
  handlePaymentAuthorized: () => void;
  prioritySectionProps: Omit<CheckoutPrioritySectionProps, 'onBack'>;
  paymentSectionProps: Omit<CheckoutPaymentSectionProps, 'onBack'>;
};

export function useCheckout({
  config,
  clinicalState,
  workflowState,
  pricingLoading,
  submitLoading,
  isLoggedIn,
  isDraftMode,
  submitBlockInfo,
  consentRequired,
  cguVersion,
  privacyVersion,
  submissionRefStateRef,
  artifactResyncFileIdsRef,
  setPriority,
  setStage,
  setSubmitError,
  setSubmitLoading,
  setPreparedSubmission,
  setSubmissionResult,
  setFiles,
  ensureSubmissionRef,
  uploadDraftArtifacts,
  finalizeSubmission,
  createPaymentIntent,
  confirmPaymentIntent,
  frontendLog,
  toPatientSafeSubmissionErrorMessage,
  safePatientNameValue,
  splitPatientNameValue,
}: UseCheckoutOptions): UseCheckoutResult {
  const preparedSubmissionFingerprintRef = useRef<string | null>(null);

  const selectedAmount = useMemo(() => {
    if (!workflowState.pricing) {
      return null;
    }
    return clinicalState.priority === 'express'
      ? workflowState.pricing.express_cents
      : workflowState.pricing.standard_cents;
  }, [clinicalState.priority, workflowState.pricing]);

  const selectedPriorityEta = useMemo(
    () => describePriorityTurnaround(clinicalState.priority, workflowState.pricing),
    [clinicalState.priority, workflowState.pricing],
  );

  const preparedSubmissionFingerprint = useMemo(() => JSON.stringify({
    flow: clinicalState.flow,
    priority: clinicalState.priority,
    fullName: safePatientNameValue(clinicalState.fullName),
    birthdate: String(clinicalState.birthdate || '').trim(),
    medicalNotes: String(clinicalState.medicalNotes || '').trim(),
    items: clinicalState.items.map((item) => ({
      cis: item.cis || null,
      cip13: item.cip13 || null,
      label: String(item.label || '').trim(),
      quantite: item.quantite || null,
      schedule: item.schedule && typeof item.schedule === 'object' ? item.schedule : null,
    })),
    files: clinicalState.files.map((entry) => ({
      id: entry.id,
      original_name: entry.original_name,
      mime_type: entry.mime_type || entry.mime || '',
      size_bytes: Number(entry.size_bytes || 0),
      kind: entry.kind,
      status: entry.status,
    })),
    attestationNoProof: clinicalState.attestationNoProof,
    consentTelemedicine: clinicalState.consentTelemedicine,
    consentTruth: clinicalState.consentTruth,
    consentCgu: clinicalState.consentCgu,
    consentPrivacy: clinicalState.consentPrivacy,
  }), [clinicalState, safePatientNameValue]);

  const invalidatePreparedSubmission = useCallback(() => {
    preparedSubmissionFingerprintRef.current = null;
    setPreparedSubmission((current) => (current ? null : current));
  }, [setPreparedSubmission]);

  useEffect(() => {
    if (!workflowState.preparedSubmission) {
      preparedSubmissionFingerprintRef.current = null;
      return;
    }

    if (!preparedSubmissionFingerprintRef.current) {
      preparedSubmissionFingerprintRef.current = preparedSubmissionFingerprint;
      return;
    }

    if (preparedSubmissionFingerprintRef.current !== preparedSubmissionFingerprint) {
      preparedSubmissionFingerprintRef.current = null;
      setPreparedSubmission(null);
    }
  }, [preparedSubmissionFingerprint, setPreparedSubmission, workflowState.preparedSubmission]);

  const handlePriorityChange = useCallback((nextPriority: 'standard' | 'express') => {
    invalidatePreparedSubmission();
    setPriority(nextPriority);
  }, [invalidatePreparedSubmission, setPriority]);

  const prepareSubmissionForPayment = useCallback(async (): Promise<SubmissionResult | null> => {
    setSubmitError(null);

    if (workflowState.preparedSubmission && Number(workflowState.preparedSubmission.id) > 0) {
      return workflowState.preparedSubmission;
    }

    setSubmitError(null);

    frontendLog('submit_clicked', 'info', {
      flow: clinicalState.flow || null,
      stage: workflowState.stage,
      logged_in: isLoggedIn,
      meds_count: clinicalState.items.length,
      files_count: clinicalState.files.length,
    });

    if (!submitBlockInfo.ok || !clinicalState.flow) {
      const message = submitBlockInfo.message || 'Le formulaire est incomplet. Merci de vérifier les champs requis.';
      frontendLog('submit_blocked', 'warning', {
        flow: clinicalState.flow || null,
        stage: workflowState.stage,
        reason_code: submitBlockInfo.code || 'unknown',
        reasons: submitBlockInfo.reasons.map((reason) => reason.code),
        message,
      });
      setSubmitError(message);
      return null;
    }

    const patientFullName = safePatientNameValue(clinicalState.fullName);
    const patientName = splitPatientNameValue(patientFullName);
    if (patientFullName.length < 3 || patientName.firstName === '' || patientName.lastName === '') {
      setSubmitError('Merci de saisir le prénom et le nom du patient, et non une adresse e-mail.');
      return null;
    }

    setSubmitLoading(true);

    try {
      const currentSubmissionRef = String(submissionRefStateRef.current.ref || '').trim();
      const submissionRef = currentSubmissionRef || await ensureSubmissionRef();

      const activeFlow = clinicalState.flow;
      if (!activeFlow) {
        throw new Error('Merci de choisir un parcours avant de continuer.');
      }

      if (artifactResyncFileIdsRef.current.length > 0) {
        const resyncIds = new Set(artifactResyncFileIdsRef.current);
        const resyncEntries = clinicalState.files.filter((entry) => (
          resyncIds.has(entry.id) && isResyncableLocalUpload(entry)
        ));

        if (resyncEntries.length > 0) {
          const resyncResults = await uploadDraftArtifacts(resyncEntries, submissionRef, (result) => {
            if (result.error) {
              setFiles((current) => current.map((file) => (
                file.id === result.entry.id
                  ? {
                    ...file,
                    status: 'QUEUED',
                  }
                  : file
              )));
              return;
            }

            setFiles((current) => current.map((file) => (
              file.id === result.entry.id
                ? {
                  ...file,
                  status: 'READY',
                }
                : file
            )));
          });

          const failedResync = resyncResults.filter((result) => result.error);
          if (failedResync.length > 0) {
            artifactResyncFileIdsRef.current = failedResync.map((result) => result.entry.id);
            throw failedResync[0].error;
          }
        }

        artifactResyncFileIdsRef.current = [];
      }

      const finalizeClinicalState: ClinicalState & { flow: FlowType } = {
        ...clinicalState,
        flow: activeFlow,
      };
      const finalizePayload = buildFinalizePayload({
        clinicalState: finalizeClinicalState,
        consentRequired,
        consentTimestamp: new Date().toISOString(),
        cguVersion,
        privacyVersion,
      });

      const allowProofOnlyFinalize = finalizeClinicalState.flow === 'ro_proof' && finalizeClinicalState.files.length > 0 && Boolean(workflowState.resumedDraftRef);
      if ((!Array.isArray(finalizePayload.items) || finalizePayload.items.length < 1) && !allowProofOnlyFinalize) {
        throw new Error(
          finalizeClinicalState.flow === 'ro_proof'
            ? 'Aucun traitement n’a pu être détecté. Merci d’ajouter un document plus lisible.'
            : 'Merci d’ajouter au moins un médicament.',
        );
      }

      frontendLog('submission_finalize_start', 'info', {
        flow: finalizeClinicalState.flow,
        items_count: finalizePayload.items.length,
        files_count: finalizeClinicalState.files.length,
      });

      const finalized = await finalizeSubmission(submissionRef, finalizePayload);
      const localPrescriptionId = Number((finalized as { local_prescription_id?: unknown }).local_prescription_id || finalized.id || 0);
      const result: SubmissionResult = {
        id: Number.isFinite(localPrescriptionId) ? localPrescriptionId : 0,
        uid: String(finalized.uid || ''),
        status: String((finalized as { local_status?: unknown }).local_status || finalized.status || 'payment_pending'),
        created_at: typeof finalized.created_at === 'string' ? finalized.created_at : undefined,
      };

      frontendLog('submission_finalize_ok', 'info', {
        flow: finalizeClinicalState.flow,
        prescription_id: result.id || null,
        uid: result.uid || null,
        status: result.status || null,
      });

      if (result.id < 1) {
        throw new Error('Prescription locale introuvable après préparation du paiement.');
      }

      preparedSubmissionFingerprintRef.current = preparedSubmissionFingerprint;
      setPreparedSubmission(result);
      return result;
    } catch (error) {
      const message = toPatientSafeSubmissionErrorMessage(error);
      frontendLog('submission_error', 'error', {
        flow: clinicalState.flow || null,
        stage: workflowState.stage,
        message,
        meds_count: clinicalState.items.length,
        files_count: clinicalState.files.length,
      });
      setSubmitError(message);
      return null;
    } finally {
      setSubmitLoading(false);
    }
  }, [
    artifactResyncFileIdsRef,
    cguVersion,
    clinicalState,
    consentRequired,
    ensureSubmissionRef,
    finalizeSubmission,
    frontendLog,
    isLoggedIn,
    preparedSubmissionFingerprint,
    privacyVersion,
    safePatientNameValue,
    setFiles,
    setPreparedSubmission,
    setSubmitError,
    setSubmitLoading,
    splitPatientNameValue,
    submissionRefStateRef,
    submitBlockInfo,
    toPatientSafeSubmissionErrorMessage,
    uploadDraftArtifacts,
    workflowState,
  ]);

  const handleContinueToPaymentAuth = useCallback(async () => {
    setSubmitError(null);

    if (pricingLoading) {
      setSubmitError('Le montant de votre demande est en cours de préparation. Merci de patienter quelques instants.');
      return;
    }

    if (!workflowState.pricing || selectedAmount == null) {
      setSubmitError('Le montant de votre demande n’est pas disponible pour le moment. Merci de réessayer.');
      return;
    }

    if (isDraftMode) {
      setStage('payment_auth');
      return;
    }

    if (!workflowState.paymentsConfig?.enabled) {
      setSubmitError('La sécurisation bancaire est actuellement indisponible. Merci de réessayer un peu plus tard.');
      return;
    }

    if (workflowState.preparedSubmission && Number(workflowState.preparedSubmission.id) > 0) {
      setStage('payment_auth');
      return;
    }

    const nextSubmission = await prepareSubmissionForPayment();
    if (nextSubmission && Number(nextSubmission.id) > 0) {
      setStage('payment_auth');
    }
  }, [isDraftMode, prepareSubmissionForPayment, pricingLoading, selectedAmount, setStage, setSubmitError, workflowState]);

  const handlePaymentAuthorized = useCallback(() => {
    if (!workflowState.preparedSubmission || Number(workflowState.preparedSubmission.id) < 1) {
      setSubmitError('Impossible de finaliser la transmission : demande préparée introuvable.');
      return;
    }

    setSubmitError(null);
    setSubmissionResult({
      ...workflowState.preparedSubmission,
      status: 'pending',
    });
    setStage('done');
  }, [setStage, setSubmissionResult, setSubmitError, workflowState.preparedSubmission]);

  const billingName = useMemo(() => {
    return safePatientNameValue(clinicalState.fullName)
      || safePatientNameValue(config.patientProfile?.fullname || '')
      || undefined;
  }, [clinicalState.fullName, config.patientProfile?.fullname, safePatientNameValue]);

  const billingEmail = useMemo(() => {
    const value = typeof config.currentUser?.email === 'string' ? config.currentUser.email.trim() : '';
    return value !== '' ? value : undefined;
  }, [config.currentUser?.email]);

  const prerequisiteError = useMemo(() => {
    if (!workflowState.preparedSubmission || Number(workflowState.preparedSubmission.id) < 1) {
      return 'Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.';
    }

    if (!workflowState.paymentsConfig?.enabled) {
      return 'La sécurisation bancaire est temporairement indisponible. Merci de réessayer un peu plus tard.';
    }

    return null;
  }, [workflowState.paymentsConfig?.enabled, workflowState.preparedSubmission]);

  const createIntent = useCallback(async () => {
    if (!workflowState.preparedSubmission || Number(workflowState.preparedSubmission.id) < 1) {
      throw new Error('Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.');
    }

    return createPaymentIntent(Number(workflowState.preparedSubmission.id), clinicalState.priority);
  }, [clinicalState.priority, createPaymentIntent, workflowState.preparedSubmission]);

  const confirmIntent = useCallback(async (paymentIntentId: string) => {
    if (!workflowState.preparedSubmission || Number(workflowState.preparedSubmission.id) < 1) {
      throw new Error('Votre dossier n’est pas encore prêt pour la sécurisation bancaire. Merci de revenir à l’étape précédente puis de réessayer.');
    }

    return confirmPaymentIntent(Number(workflowState.preparedSubmission.id), paymentIntentId);
  }, [confirmPaymentIntent, workflowState.preparedSubmission]);

  const handleAuthorizedState = useCallback((event: 'resume' | 'authorized', meta: StripePaymentResolutionMeta) => {
    if (!workflowState.preparedSubmission) {
      return;
    }

    if (event === 'resume') {
      frontendLog('payment_authorization_resume_ok', 'info', {
        prescription_id: workflowState.preparedSubmission.id,
        uid: workflowState.preparedSubmission.uid,
        payment_intent_id: meta.paymentIntentId,
        priority: clinicalState.priority,
        status: meta.status,
      });
      return;
    }

    frontendLog('payment_authorization_ok', 'info', {
      prescription_id: workflowState.preparedSubmission.id,
      uid: workflowState.preparedSubmission.uid,
      payment_intent_id: meta.paymentIntentId,
      priority: clinicalState.priority,
      status: meta.status,
    });
  }, [clinicalState.priority, frontendLog, workflowState.preparedSubmission]);

  const handlePaymentError = useCallback(({ message }: { mode: 'tunnel' | 'patient_space'; error: unknown; message: string }) => {
    if (!workflowState.preparedSubmission) {
      return;
    }

    frontendLog('payment_authorization_error', 'error', {
      prescription_id: workflowState.preparedSubmission.id,
      uid: workflowState.preparedSubmission.uid,
      priority: clinicalState.priority,
      message,
    });
  }, [clinicalState.priority, frontendLog, workflowState.preparedSubmission]);

  const stripeProps = useMemo<StripeTunnelProps>(() => ({
    billingName,
    billingEmail,
    fallbackPublishableKey: String(workflowState.paymentsConfig?.publishable_key || '').trim() || null,
    prerequisiteError,
    createIntent,
    confirmIntent,
    onAuthorized: handlePaymentAuthorized,
    onAuthorizedState: handleAuthorizedState,
    onErrorState: handlePaymentError,
    safeErrorMessage: toMedicalGradePaymentErrorMessage,
  }), [
    billingEmail,
    billingName,
    confirmIntent,
    createIntent,
    handleAuthorizedState,
    handlePaymentAuthorized,
    handlePaymentError,
    prerequisiteError,
    workflowState.paymentsConfig?.publishable_key,
  ]);

  const prioritySectionProps = useMemo<Omit<CheckoutPrioritySectionProps, 'onBack'>>(() => ({
    flow: clinicalState.flow as FlowType,
    itemsCount: clinicalState.items.length,
    filesCount: clinicalState.files.length,
    pricingLoading,
    pricing: workflowState.pricing,
    priority: clinicalState.priority,
    selectedAmount,
    selectedPriorityEta,
    onPriorityChange: handlePriorityChange,
    onContinue: handleContinueToPaymentAuth,
    continueDisabled: submitLoading || pricingLoading || !workflowState.pricing,
  }), [
    clinicalState.files.length,
    clinicalState.flow,
    clinicalState.items.length,
    clinicalState.priority,
    handleContinueToPaymentAuth,
    handlePriorityChange,
    pricingLoading,
    selectedAmount,
    selectedPriorityEta,
    submitLoading,
    workflowState.pricing,
  ]);

  const paymentSectionProps = useMemo<Omit<CheckoutPaymentSectionProps, 'onBack'>>(() => ({
    priority: clinicalState.priority,
    pricingLoading,
    pricing: workflowState.pricing,
    selectedAmount,
    selectedPriorityEta,
    stripeProps,
  }), [clinicalState.priority, pricingLoading, selectedAmount, selectedPriorityEta, stripeProps, workflowState.pricing]);

  return {
    selectedAmount,
    selectedPriorityEta,
    invalidatePreparedSubmission,
    handlePriorityChange,
    prepareSubmissionForPayment,
    handleContinueToPaymentAuth,
    handlePaymentAuthorized,
    prioritySectionProps,
    paymentSectionProps,
  };
}
