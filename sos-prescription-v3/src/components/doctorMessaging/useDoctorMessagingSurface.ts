import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import useDoctorMessagingRuntime, {
  type DoctorMessagingThreadLoadRequest,
  type MessageItem,
  type PolishResult,
  type SmartReplyOption,
  type UploadedFile,
} from './useDoctorMessagingRuntime';
import {
  apiJson,
  findDoctorMessagingHost,
  getAppConfig,
  getDoctorSmartReplies,
  loadDoctorThreadTransport,
  markDoctorMessagesRead,
  normalizeDoctorSelectedStatus,
  normalizeMode,
  normalizeSmartReplies,
  polishDoctorMessage,
  postDoctorMessage,
  requestArtifactAccess,
  type ApiRequestOptions,
  type PolishPayload,
  type ThreadState,
} from './doctorMessagingSurfaceTransport';

type ViewerRole = 'DOCTOR';

type ThreadRefreshReason = 'bootstrap' | 'poll' | 'message-created' | 'visibility' | 'focus' | 'interaction';

type ThreadRefreshRequest = {
  silent: boolean;
  reason: ThreadRefreshReason;
  bypassInFlightDedup: boolean;
};

type UseDoctorMessagingSurfaceArgs = {
  prescriptionId: number;
};

type UseDoctorMessagingSurfaceResult = {
  surfaceRef: RefObject<HTMLDivElement | null>;
  flash: string | null;
  surfaceError: string | null;
  threadSurfaceError: string | null;
  assistantSurfaceError: string | null;
  modeNotice: string;
  messageThreadProps: {
    prescriptionId: number;
    viewerRole: ViewerRole;
    currentUserRoles: string[] | string | undefined;
    title: string;
    subtitle: string;
    loading: boolean;
    emptyText: string;
    messages: MessageItem[];
    fileIndex: Record<number, UploadedFile>;
    onDownloadFile: (attachmentId: number) => Promise<void>;
    canCompose: boolean;
    readOnlyNotice: string;
    postMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
    onMessageCreated: (message: MessageItem) => Promise<void>;
    onSurfaceError: (message: string | null) => void;
    assistantEnabled: boolean;
    onPolishDraft?: (draft: string) => Promise<PolishResult>;
    smartReplies: SmartReplyOption[];
  };
};

const POLL_VISIBLE_MS = 15000;
const POLL_HIDDEN_MS = 30000;
const POLL_VISIBLE_STABLE_MS = 30000;
const POLL_VISIBLE_IDLE_MS = 60000;
const DOCTOR_EXPLICIT_REFRESH_DEBOUNCE_MS = 160;
const DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS = 1200;

function normalizeDoctorStableSelectionStatus(value: unknown): string {
  return normalizeDoctorSelectedStatus(value);
}

function isDoctorStableSelectionStatus(value: unknown): boolean {
  const normalized = normalizeDoctorStableSelectionStatus(value);
  return normalized === 'approved'
    || normalized === 'rejected'
    || normalized === 'closed'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'archived'
    || normalized === 'completed'
    || normalized === 'done'
    || normalized === 'expired';
}

function shouldSuspendDoctorThreadPolling(selectedStatus: unknown, nextThreadState: ThreadState): boolean {
  return isDoctorStableSelectionStatus(selectedStatus)
    && Number(nextThreadState.unread_count_doctor || 0) < 1;
}

function resolveDoctorThreadPollDelay(
  hidden: boolean,
  nextThreadState: ThreadState,
  unchangedCount: number,
  pollingSuspended: boolean,
): number | null {
  if (pollingSuspended) {
    return null;
  }

  const unreadCount = Number(nextThreadState.unread_count_doctor || 0);
  if (hidden) {
    return unreadCount > 0 ? POLL_HIDDEN_MS : null;
  }

  if (unreadCount > 0) {
    return POLL_VISIBLE_MS;
  }

  if (unchangedCount >= 4) {
    return POLL_VISIBLE_IDLE_MS;
  }

  if (unchangedCount >= 2) {
    return POLL_VISIBLE_STABLE_MS;
  }

  return POLL_VISIBLE_MS;
}

function isExplicitDoctorThreadRefreshReason(reason: ThreadRefreshReason): boolean {
  return reason === 'visibility' || reason === 'focus' || reason === 'interaction';
}

function mergeThreadRefreshRequest(
  current: ThreadRefreshRequest | null,
  next: ThreadRefreshRequest,
): ThreadRefreshRequest {
  if (!current) {
    return next;
  }

  return {
    silent: current.silent && next.silent,
    reason: next.reason,
    bypassInFlightDedup: current.bypassInFlightDedup || next.bypassInFlightDedup,
  };
}

function threadModeNotice(mode: 'DOCTOR_ONLY' | 'PATIENT_REPLY' | 'READ_ONLY' | ''): string {
  if (mode === 'READ_ONLY') {
    return 'La messagerie est en lecture seule pour ce dossier.';
  }
  if (mode === 'DOCTOR_ONLY') {
    return 'Vous pouvez envoyer un message sécurisé au patient depuis cet espace dès que vous en avez besoin.';
  }
  return '';
}

export default function useDoctorMessagingSurface({ prescriptionId }: UseDoctorMessagingSurfaceArgs): UseDoctorMessagingSurfaceResult {
  const cfg = getAppConfig();
  const [threadState, setThreadState] = useState<ThreadState>({});
  const [files] = useState<Record<number, UploadedFile>>({});
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(typeof document !== 'undefined' ? document.hidden : false);
  const [selectedStatus, setSelectedStatus] = useState<string>(() => normalizeDoctorSelectedStatus(findDoctorMessagingHost(prescriptionId)?.dataset.prescriptionStatus || ''));

  const mountedRef = useRef(true);
  const markReadSeqRef = useRef(0);
  const interactionRefreshAtRef = useRef(0);
  const syncThreadPromiseRef = useRef<Promise<void> | null>(null);
  const pendingThreadRefreshRef = useRef<ThreadRefreshRequest | null>(null);
  const scheduledThreadRefreshRef = useRef<ThreadRefreshRequest | null>(null);
  const explicitRefreshTimerRef = useRef<number | null>(null);
  const threadStateRef = useRef<ThreadState>({});
  const threadPollTimerRef = useRef<number | null>(null);
  const threadUnchangedCountRef = useRef(0);
  const loadThreadOptionsRef = useRef<ApiRequestOptions | undefined>(undefined);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const viewerRole: ViewerRole = 'DOCTOR';
  const mode = normalizeMode(threadState.mode);
  const modeNotice = useMemo(() => threadModeNotice(mode), [mode]);
  const threadPollingSuspended = useMemo(
    () => shouldSuspendDoctorThreadPolling(selectedStatus, threadState),
    [selectedStatus, threadState],
  );

  const fileIndex = useMemo(() => files, [files]);
  const currentUserRoles = cfg.currentUser?.roles;

  const clearThreadPollTimer = useCallback((): void => {
    if (threadPollTimerRef.current !== null) {
      window.clearTimeout(threadPollTimerRef.current);
      threadPollTimerRef.current = null;
    }
  }, []);

  const clearExplicitRefreshTimer = useCallback((): void => {
    if (explicitRefreshTimerRef.current !== null) {
      window.clearTimeout(explicitRefreshTimerRef.current);
      explicitRefreshTimerRef.current = null;
    }
    scheduledThreadRefreshRef.current = null;
  }, []);

  useEffect(() => {
    threadStateRef.current = threadState;
  }, [threadState]);

  const markReadIfNeeded = useCallback(async (nextThreadState: ThreadState): Promise<void> => {
    const unreadCount = Number(nextThreadState.unread_count_doctor || 0);
    const lastMessageSeq = Number(nextThreadState.last_message_seq || 0);

    if (unreadCount < 1 || lastMessageSeq < 1 || markReadSeqRef.current === lastMessageSeq) {
      return;
    }

    markReadSeqRef.current = lastMessageSeq;

    try {
      const payload = await markDoctorMessagesRead(prescriptionId, lastMessageSeq);
      if (!mountedRef.current) {
        return;
      }
      if (payload && payload.thread_state) {
        threadStateRef.current = payload.thread_state;
        setThreadState(payload.thread_state);
      }
    } catch {
      markReadSeqRef.current = 0;
    }
  }, [prescriptionId]);

  const assignConversation = useCallback(async (targetPrescriptionId: number): Promise<unknown> => {
    return apiJson(`/prescriptions/${targetPrescriptionId}/assign`, { method: 'POST' }, 'admin');
  }, []);

  const loadThread = useCallback(async (targetPrescriptionId: number, request?: DoctorMessagingThreadLoadRequest) => {
    const currentThreadState = threadStateRef.current;
    const normalizedPayload = await loadDoctorThreadTransport(
      targetPrescriptionId,
      request,
      currentThreadState,
      loadThreadOptionsRef.current,
    );
    const nextThreadState = normalizedPayload.threadState;

    threadStateRef.current = nextThreadState;
    threadUnchangedCountRef.current = normalizedPayload.kind === 'unchanged' ? threadUnchangedCountRef.current + 1 : 0;

    if (mountedRef.current) {
      setThreadState(nextThreadState);
    }

    if (Number(nextThreadState.unread_count_doctor || 0) > 0) {
      void markReadIfNeeded(nextThreadState);
    }

    let nextSmartReplies: SmartReplyOption[] = [];
    try {
      nextSmartReplies = normalizeSmartReplies(await getDoctorSmartReplies(targetPrescriptionId));
    } catch {
      nextSmartReplies = [];
    }

    return {
      kind: normalizedPayload.kind,
      messages: normalizedPayload.messages,
      thread_state: nextThreadState,
      unchanged: normalizedPayload.unchanged,
      canCompose: normalizeMode(nextThreadState.mode) !== 'READ_ONLY',
      readOnlyNotice: 'La messagerie est en lecture seule pour ce dossier.',
      emptyText: 'Aucun message pour le moment.',
      subtitle: 'Initiez ici l’échange sécurisé avec le patient si une précision médicale ou documentaire est nécessaire.',
      smartReplies: nextSmartReplies,
      assistantEnabled: true,
    };
  }, [markReadIfNeeded]);

  const postMessageTransport = useCallback(async (targetPrescriptionId: number, body: string, attachments?: number[]): Promise<MessageItem> => {
    return postDoctorMessage(targetPrescriptionId, body, attachments);
  }, []);

  const polishDraftTransport = useCallback(async (targetPrescriptionId: number, draft: string): Promise<PolishPayload> => {
    return polishDoctorMessage(targetPrescriptionId, draft);
  }, []);

  const {
    messages,
    messagesLoading,
    threadSurfaceError,
    assistantSurfaceError,
    assignBusy,
    assignReady,
    assistantEnabled,
    smartReplies,
    canCompose,
    readOnlyNotice,
    emptyText,
    subtitle,
    syncThread,
    postMessage,
    onMessageCreated,
    onPolishDraft,
    onSurfaceError,
  } = useDoctorMessagingRuntime({
    prescriptionId,
    assignConversation,
    loadThread,
    postMessageTransport,
    polishDraftTransport,
  });

  const runThreadRefresh = useCallback(async function runThreadRefreshImpl(next: ThreadRefreshRequest): Promise<void> {
    if (syncThreadPromiseRef.current) {
      pendingThreadRefreshRef.current = mergeThreadRefreshRequest(pendingThreadRefreshRef.current, next);
      await syncThreadPromiseRef.current;
      return;
    }

    loadThreadOptionsRef.current = {
      bypassInFlightDedup: next.bypassInFlightDedup,
    };

    const refreshPromise = syncThread().finally(() => {
      loadThreadOptionsRef.current = undefined;

      if (syncThreadPromiseRef.current !== refreshPromise) {
        return;
      }

      syncThreadPromiseRef.current = null;

      const pending = pendingThreadRefreshRef.current;
      pendingThreadRefreshRef.current = null;

      if (!mountedRef.current || !pending) {
        return;
      }

      void runThreadRefreshImpl(pending);
    });

    syncThreadPromiseRef.current = refreshPromise;
    await refreshPromise;
  }, [syncThread]);

  const flushScheduledThreadRefresh = useCallback((): void => {
    explicitRefreshTimerRef.current = null;

    const scheduled = scheduledThreadRefreshRef.current;
    scheduledThreadRefreshRef.current = null;

    if (!scheduled) {
      return;
    }

    const now = Date.now();
    const elapsed = now - interactionRefreshAtRef.current;
    if (elapsed < DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS) {
      const delay = Math.max(
        DOCTOR_EXPLICIT_REFRESH_DEBOUNCE_MS,
        DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS - elapsed,
      );

      scheduledThreadRefreshRef.current = mergeThreadRefreshRequest(scheduledThreadRefreshRef.current, scheduled);
      explicitRefreshTimerRef.current = window.setTimeout(flushScheduledThreadRefresh, delay);
      return;
    }

    interactionRefreshAtRef.current = now;
    void runThreadRefresh(scheduled);
  }, [runThreadRefresh]);

  const requestThreadRefresh = useCallback((options: Partial<ThreadRefreshRequest> = {}): void => {
    const next: ThreadRefreshRequest = {
      silent: options.silent ?? true,
      reason: options.reason ?? 'interaction',
      bypassInFlightDedup: Boolean(options.bypassInFlightDedup),
    };

    if (isExplicitDoctorThreadRefreshReason(next.reason)) {
      const now = Date.now();
      const elapsed = now - interactionRefreshAtRef.current;
      const delay = elapsed >= DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS
        ? DOCTOR_EXPLICIT_REFRESH_DEBOUNCE_MS
        : Math.max(
            DOCTOR_EXPLICIT_REFRESH_DEBOUNCE_MS,
            DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS - elapsed,
          );

      scheduledThreadRefreshRef.current = mergeThreadRefreshRequest(scheduledThreadRefreshRef.current, next);

      if (explicitRefreshTimerRef.current !== null) {
        return;
      }

      explicitRefreshTimerRef.current = window.setTimeout(flushScheduledThreadRefresh, delay);
      return;
    }

    if (next.reason !== 'poll') {
      interactionRefreshAtRef.current = Date.now();
    }

    void runThreadRefresh(next);
  }, [flushScheduledThreadRefresh, runThreadRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    markReadSeqRef.current = 0;
    interactionRefreshAtRef.current = 0;
    syncThreadPromiseRef.current = null;
    pendingThreadRefreshRef.current = null;
    threadStateRef.current = {};
    threadUnchangedCountRef.current = 0;
    loadThreadOptionsRef.current = undefined;
    clearExplicitRefreshTimer();
    clearThreadPollTimer();
    setThreadState({});
    setSurfaceError(null);
    setFlash(null);

    return () => {
      mountedRef.current = false;
      clearExplicitRefreshTimer();
      clearThreadPollTimer();
    };
  }, [clearExplicitRefreshTimer, clearThreadPollTimer, prescriptionId]);

  useEffect(() => {
    const triggerNow = (reason: 'visibility' | 'focus'): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      requestThreadRefresh({
        silent: true,
        reason,
        bypassInFlightDedup: true,
      });
    };

    const handleVisibilityChange = (): void => {
      const nextHidden = document.hidden;
      setHidden(nextHidden);
      if (!nextHidden && document.visibilityState === 'visible') {
        triggerNow('visibility');
      }
    };

    const handleWindowFocus = (): void => {
      triggerNow('focus');
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [requestThreadRefresh]);

  useEffect(() => {
    const host = findDoctorMessagingHost(prescriptionId);
    if (!(host instanceof HTMLElement) || typeof MutationObserver === 'undefined') {
      setSelectedStatus(normalizeDoctorSelectedStatus(host?.dataset.prescriptionStatus || ''));
      return;
    }

    const syncSelectedStatus = (): void => {
      setSelectedStatus(normalizeDoctorSelectedStatus(host.dataset.prescriptionStatus || ''));
    };

    syncSelectedStatus();

    const observer = new MutationObserver(syncSelectedStatus);
    observer.observe(host, {
      attributes: true,
      attributeFilter: ['data-prescription-status'],
    });

    return () => {
      observer.disconnect();
    };
  }, [prescriptionId]);

  useEffect(() => {
    if (threadPollingSuspended) {
      clearThreadPollTimer();
      return;
    }

    let disposed = false;

    const scheduleNext = (): void => {
      if (disposed) {
        return;
      }

      clearThreadPollTimer();
      const delay = resolveDoctorThreadPollDelay(hidden, threadStateRef.current, threadUnchangedCountRef.current, threadPollingSuspended);
      if (delay === null) {
        return;
      }

      threadPollTimerRef.current = window.setTimeout(() => {
        void (async () => {
          await runThreadRefresh({
            silent: true,
            reason: 'poll',
            bypassInFlightDedup: false,
          });
          if (!disposed) {
            scheduleNext();
          }
        })();
      }, delay);
    };

    scheduleNext();

    return () => {
      disposed = true;
      clearThreadPollTimer();
    };
  }, [clearThreadPollTimer, hidden, runThreadRefresh, threadPollingSuspended]);

  useEffect(() => {
    if (!threadPollingSuspended) {
      return;
    }

    const surface = surfaceRef.current;
    if (!(surface instanceof HTMLElement)) {
      return;
    }

    const handleInteractionRefresh = (): void => {
      requestThreadRefresh({
        silent: true,
        reason: 'interaction',
        bypassInFlightDedup: true,
      });
    };

    surface.addEventListener('click', handleInteractionRefresh);
    surface.addEventListener('focusin', handleInteractionRefresh);
    surface.addEventListener('keydown', handleInteractionRefresh);

    return () => {
      surface.removeEventListener('click', handleInteractionRefresh);
      surface.removeEventListener('focusin', handleInteractionRefresh);
      surface.removeEventListener('keydown', handleInteractionRefresh);
    };
  }, [requestThreadRefresh, threadPollingSuspended]);

  useEffect(() => {
    if (!flash) {
      return;
    }

    const timer = window.setTimeout(() => {
      setFlash(null);
    }, 2500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [flash]);

  const handleMessageCreated = useCallback(async (message: MessageItem): Promise<void> => {
    setFlash('Message envoyé.');
    await onMessageCreated(message);
  }, [onMessageCreated]);

  const handleAttachmentDownload = useCallback(async (attachmentId: number): Promise<void> => {
    try {
      const file = fileIndex[attachmentId];
      const access = await requestArtifactAccess(attachmentId, prescriptionId);
      const accessUrl = access && access.access && typeof access.access.url === 'string' ? access.access.url : '';
      if (!accessUrl) {
        throw new Error('Lien de téléchargement indisponible.');
      }

      const anchor = document.createElement('a');
      anchor.href = accessUrl;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.download = file && file.original_name ? file.original_name : '';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      setSurfaceError(err instanceof Error ? err.message : 'Impossible de télécharger le document.');
    }
  }, [fileIndex, prescriptionId]);

  const messageThreadProps = useMemo(() => ({
    prescriptionId,
    viewerRole,
    currentUserRoles,
    title: 'Échanges avec le patient',
    subtitle,
    loading: messagesLoading || assignBusy,
    emptyText,
    messages,
    fileIndex,
    onDownloadFile: handleAttachmentDownload,
    canCompose: canCompose && assignReady,
    readOnlyNotice,
    postMessage,
    onMessageCreated: handleMessageCreated,
    onSurfaceError,
    assistantEnabled,
    onPolishDraft,
    smartReplies,
  }), [
    prescriptionId,
    currentUserRoles,
    subtitle,
    messagesLoading,
    assignBusy,
    emptyText,
    messages,
    fileIndex,
    handleAttachmentDownload,
    canCompose,
    assignReady,
    readOnlyNotice,
    postMessage,
    handleMessageCreated,
    onSurfaceError,
    assistantEnabled,
    onPolishDraft,
    smartReplies,
  ]);

  return {
    surfaceRef,
    flash,
    surfaceError,
    threadSurfaceError,
    assistantSurfaceError,
    modeNotice,
    messageThreadProps,
  };
}
