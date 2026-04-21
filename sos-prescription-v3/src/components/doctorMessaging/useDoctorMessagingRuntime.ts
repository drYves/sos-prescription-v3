import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type UploadedFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url?: string;
};

export type MessageItem = {
  id: number;
  seq?: number;
  author_role: string;
  author_wp_user_id?: number;
  author_name?: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

export type SmartReplyOption = {
  type?: string;
  title?: string;
  body: string;
};

export type PolishResult = {
  rewritten_body?: string;
  changes_summary?: string[];
  risk_flags?: string[];
};

export type DoctorMessagingThreadPayload = {
  messages?: MessageItem[];
  canCompose?: boolean;
  readOnlyNotice?: string;
  emptyText?: string;
  subtitle?: string;
  smartReplies?: SmartReplyOption[];
  assistantEnabled?: boolean;
};

export type UseDoctorMessagingRuntimeArgs = {
  prescriptionId: number | null;
  assignConversation: (prescriptionId: number) => Promise<unknown>;
  loadThread: (prescriptionId: number) => Promise<DoctorMessagingThreadPayload>;
  postMessageTransport: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  polishDraftTransport?: (prescriptionId: number, draft: string) => Promise<PolishResult>;
};

export type UseDoctorMessagingRuntimeResult = {
  messages: MessageItem[];
  messagesLoading: boolean;
  threadSurfaceError: string | null;
  assistantSurfaceError: string | null;
  assignBusy: boolean;
  assignReady: boolean;
  assistantEnabled: boolean;
  assistantBusy: boolean;
  smartReplies: SmartReplyOption[];
  canCompose: boolean;
  readOnlyNotice: string;
  emptyText: string;
  subtitle: string;
  syncThread: () => Promise<void>;
  postMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  onMessageCreated: (message: MessageItem) => Promise<void>;
  onPolishDraft?: (draft: string) => Promise<PolishResult>;
  onSurfaceError: (message: string | null) => void;
  invalidateConversationContext: () => void;
};

const DEFAULT_READ_ONLY_NOTICE = 'Cette conversation sécurisée est momentanément en lecture seule.';
const DEFAULT_EMPTY_TEXT = 'Aucun message pour le moment.';
const DEFAULT_SUBTITLE = '';
const DEFAULT_THREAD_ERROR = 'Service de messagerie temporairement indisponible.';
const DEFAULT_ASSISTANT_ERROR = 'Aide à la rédaction momentanément indisponible.';

function normalizePrescriptionId(value: number | null | undefined): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStatusCode(error: unknown): number {
  if (!isRecord(error)) {
    return 0;
  }

  const status = Number((error as { status?: unknown }).status);
  if (Number.isFinite(status) && status > 0) {
    return Math.trunc(status);
  }

  const response = (error as { response?: unknown }).response;
  if (isRecord(response)) {
    const responseStatus = Number((response as { status?: unknown }).status);
    if (Number.isFinite(responseStatus) && responseStatus > 0) {
      return Math.trunc(responseStatus);
    }
  }

  return 0;
}

function readErrorCode(error: unknown): string {
  if (!isRecord(error)) {
    return '';
  }

  const directCode = normalizeText((error as { code?: unknown }).code).trim();
  if (directCode !== '') {
    return directCode;
  }

  const response = (error as { response?: unknown }).response;
  if (isRecord(response)) {
    const responseCode = normalizeText((response as { code?: unknown }).code).trim();
    if (responseCode !== '') {
      return responseCode;
    }

    const data = (response as { data?: unknown }).data;
    if (isRecord(data)) {
      const dataCode = normalizeText((data as { code?: unknown }).code).trim();
      if (dataCode !== '') {
        return dataCode;
      }
    }
  }

  return '';
}

function resolveUnknownErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const normalized = error.message.trim();
    return normalized !== '' ? normalized : fallback;
  }

  if (isRecord(error)) {
    const direct = normalizeText((error as { message?: unknown }).message).trim();
    if (direct !== '') {
      return direct;
    }

    const response = (error as { response?: unknown }).response;
    if (isRecord(response)) {
      const responseMessage = normalizeText((response as { message?: unknown }).message).trim();
      if (responseMessage !== '') {
        return responseMessage;
      }

      const data = (response as { data?: unknown }).data;
      if (isRecord(data)) {
        const dataMessage = normalizeText((data as { message?: unknown }).message).trim();
        if (dataMessage !== '') {
          return dataMessage;
        }
      }
    }
  }

  return fallback;
}

function isBenignAssignConflict(error: unknown): boolean {
  const status = readStatusCode(error);
  const code = readErrorCode(error).toLowerCase();
  const message = resolveUnknownErrorMessage(error, '').toLowerCase();

  if (status !== 409) {
    return false;
  }

  if (code === '') {
    return true;
  }

  return (
    code.includes('already')
    || code.includes('assigned')
    || code.includes('claim')
    || message.includes('already')
    || message.includes('assign')
  );
}

function normalizeMessages(input: unknown): MessageItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((entry): entry is MessageItem => isRecord(entry) && Number.isFinite(Number((entry as { id?: unknown }).id)))
    .map((entry) => ({
      id: Number((entry as { id: unknown }).id),
      seq: Number.isFinite(Number((entry as { seq?: unknown }).seq)) ? Number((entry as { seq?: unknown }).seq) : undefined,
      author_role: normalizeText((entry as { author_role?: unknown }).author_role),
      author_wp_user_id: Number.isFinite(Number((entry as { author_wp_user_id?: unknown }).author_wp_user_id))
        ? Number((entry as { author_wp_user_id?: unknown }).author_wp_user_id)
        : undefined,
      author_name: typeof (entry as { author_name?: unknown }).author_name === 'string'
        ? (entry as { author_name?: string }).author_name
        : undefined,
      body: normalizeText((entry as { body?: unknown }).body),
      created_at: normalizeText((entry as { created_at?: unknown }).created_at),
      attachments: Array.isArray((entry as { attachments?: unknown }).attachments)
        ? ((entry as { attachments?: unknown[] }).attachments || [])
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0)
        : undefined,
    }));
}

function normalizeSmartReplies(input: unknown): SmartReplyOption[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((entry): entry is SmartReplyOption => isRecord(entry) && typeof (entry as { body?: unknown }).body === 'string')
    .map((entry) => ({
      type: typeof (entry as { type?: unknown }).type === 'string' ? (entry as { type?: string }).type : undefined,
      title: typeof (entry as { title?: unknown }).title === 'string' ? (entry as { title?: string }).title : undefined,
      body: normalizeText((entry as { body?: unknown }).body),
    }))
    .filter((entry) => entry.body.trim() !== '');
}

function normalizeThreadPayload(input: DoctorMessagingThreadPayload | unknown): Required<DoctorMessagingThreadPayload> {
  if (!isRecord(input)) {
    return {
      messages: [],
      canCompose: false,
      readOnlyNotice: DEFAULT_READ_ONLY_NOTICE,
      emptyText: DEFAULT_EMPTY_TEXT,
      subtitle: DEFAULT_SUBTITLE,
      smartReplies: [],
      assistantEnabled: false,
    };
  }

  return {
    messages: normalizeMessages((input as { messages?: unknown }).messages),
    canCompose: Boolean((input as { canCompose?: unknown }).canCompose),
    readOnlyNotice: normalizeText((input as { readOnlyNotice?: unknown }).readOnlyNotice, DEFAULT_READ_ONLY_NOTICE),
    emptyText: normalizeText((input as { emptyText?: unknown }).emptyText, DEFAULT_EMPTY_TEXT),
    subtitle: normalizeText((input as { subtitle?: unknown }).subtitle, DEFAULT_SUBTITLE),
    smartReplies: normalizeSmartReplies((input as { smartReplies?: unknown }).smartReplies),
    assistantEnabled: Boolean((input as { assistantEnabled?: unknown }).assistantEnabled),
  };
}

function messageIdentity(message: MessageItem): string {
  const seq = Number(message.seq || 0);
  if (Number.isFinite(seq) && seq > 0) {
    return `seq:${seq}`;
  }

  const id = Number(message.id || 0);
  if (Number.isFinite(id) && id > 0) {
    return `id:${id}`;
  }

  return `${message.author_role}:${message.created_at}:${message.body}`;
}

function mergeMessageItem(previous: MessageItem[], nextMessage: MessageItem): MessageItem[] {
  const identity = messageIdentity(nextMessage);
  const filtered = previous.filter((message) => messageIdentity(message) !== identity);
  const merged = [...filtered, nextMessage];

  return merged.sort((left, right) => {
    const leftSeq = Number(left.seq || 0);
    const rightSeq = Number(right.seq || 0);
    if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }

    return String(left.created_at || '').localeCompare(String(right.created_at || ''));
  });
}

export default function useDoctorMessagingRuntime({
  prescriptionId,
  assignConversation,
  loadThread,
  postMessageTransport,
  polishDraftTransport,
}: UseDoctorMessagingRuntimeArgs): UseDoctorMessagingRuntimeResult {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [threadSurfaceError, setThreadSurfaceError] = useState<string | null>(null);
  const [assistantSurfaceError, setAssistantSurfaceError] = useState<string | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignReady, setAssignReady] = useState(false);
  const [assistantEnabled, setAssistantEnabled] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [smartReplies, setSmartReplies] = useState<SmartReplyOption[]>([]);
  const [canCompose, setCanCompose] = useState(false);
  const [readOnlyNotice, setReadOnlyNotice] = useState(DEFAULT_READ_ONLY_NOTICE);
  const [emptyText, setEmptyText] = useState(DEFAULT_EMPTY_TEXT);
  const [subtitle, setSubtitle] = useState(DEFAULT_SUBTITLE);

  const runtimeVersionRef = useRef(0);
  const prescriptionIdRef = useRef(0);
  const assignInFlightRef = useRef<Map<number, Promise<boolean>>>(new Map());

  const invalidateConversationContext = useCallback((): void => {
    runtimeVersionRef.current += 1;
    setAssignBusy(false);
    setAssignReady(false);
    setMessagesLoading(false);
    setAssistantBusy(false);
    setThreadSurfaceError(null);
    setAssistantSurfaceError(null);
    setMessages([]);
    setSmartReplies([]);
    setAssistantEnabled(false);
    setCanCompose(false);
    setReadOnlyNotice(DEFAULT_READ_ONLY_NOTICE);
    setEmptyText(DEFAULT_EMPTY_TEXT);
    setSubtitle(DEFAULT_SUBTITLE);
  }, []);

  const ensureAssigned = useCallback(
    async (nextPrescriptionId: number, contextVersion: number): Promise<boolean> => {
      if (nextPrescriptionId < 1) {
        return false;
      }

      const existingPromise = assignInFlightRef.current.get(nextPrescriptionId);
      if (existingPromise) {
        return existingPromise;
      }

      setAssignBusy(true);

      const assignPromise = (async (): Promise<boolean> => {
        try {
          await assignConversation(nextPrescriptionId);
          return true;
        } catch (error) {
          if (isBenignAssignConflict(error)) {
            return true;
          }
          throw error;
        } finally {
          assignInFlightRef.current.delete(nextPrescriptionId);
        }
      })();

      assignInFlightRef.current.set(nextPrescriptionId, assignPromise);

      try {
        const ready = await assignPromise;
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          setAssignReady(ready);
          setThreadSurfaceError(null);
        }
        return ready;
      } catch (error) {
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          setAssignReady(false);
          setThreadSurfaceError(resolveUnknownErrorMessage(error, DEFAULT_THREAD_ERROR));
        }
        throw error;
      } finally {
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          setAssignBusy(false);
        }
      }
    },
    [assignConversation],
  );

  const syncThreadForPrescription = useCallback(
    async (nextPrescriptionId: number): Promise<void> => {
      if (nextPrescriptionId < 1) {
        return;
      }

      const contextVersion = runtimeVersionRef.current;
      setMessagesLoading(true);

      try {
        const ready = await ensureAssigned(nextPrescriptionId, contextVersion);
        if (!ready) {
          return;
        }

        if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
          return;
        }

        const payload = normalizeThreadPayload(await loadThread(nextPrescriptionId));
        if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
          return;
        }

        const effectiveAssistantEnabled = Boolean(payload.assistantEnabled && ready && polishDraftTransport);

        setMessages(payload.messages);
        setCanCompose(Boolean(payload.canCompose));
        setReadOnlyNotice(payload.readOnlyNotice || DEFAULT_READ_ONLY_NOTICE);
        setEmptyText(payload.emptyText || DEFAULT_EMPTY_TEXT);
        setSubtitle(payload.subtitle || DEFAULT_SUBTITLE);
        setSmartReplies(effectiveAssistantEnabled ? payload.smartReplies : []);
        setAssistantEnabled(effectiveAssistantEnabled);
        setAssistantSurfaceError(null);
        setThreadSurfaceError(null);
      } catch (error) {
        if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
          return;
        }

        setAssistantEnabled(false);
        setSmartReplies([]);
        setThreadSurfaceError(resolveUnknownErrorMessage(error, DEFAULT_THREAD_ERROR));
      } finally {
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          setMessagesLoading(false);
        }
      }
    },
    [ensureAssigned, loadThread, polishDraftTransport],
  );

  const syncThread = useCallback(async (): Promise<void> => {
    const nextPrescriptionId = prescriptionIdRef.current;
    if (nextPrescriptionId < 1) {
      return;
    }

    await syncThreadForPrescription(nextPrescriptionId);
  }, [syncThreadForPrescription]);

  const postMessage = useCallback(
    async (targetPrescriptionId: number, body: string, attachments?: number[]): Promise<MessageItem> => {
      const nextPrescriptionId = normalizePrescriptionId(targetPrescriptionId || prescriptionIdRef.current);
      if (nextPrescriptionId < 1) {
        throw new Error(DEFAULT_THREAD_ERROR);
      }

      const contextVersion = runtimeVersionRef.current;
      await ensureAssigned(nextPrescriptionId, contextVersion);

      if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
        throw new Error(DEFAULT_THREAD_ERROR);
      }

      return postMessageTransport(nextPrescriptionId, body, attachments);
    },
    [ensureAssigned, postMessageTransport],
  );

  const onMessageCreated = useCallback(
    async (message: MessageItem): Promise<void> => {
      setMessages((previous) => mergeMessageItem(previous, message));
      setThreadSurfaceError(null);
      await syncThread();
    },
    [syncThread],
  );

  const onPolishDraft = useMemo(() => {
    if (!(assistantEnabled && assignReady && polishDraftTransport)) {
      return undefined;
    }

    return async (draft: string): Promise<PolishResult> => {
      const nextPrescriptionId = prescriptionIdRef.current;
      const contextVersion = runtimeVersionRef.current;

      if (nextPrescriptionId < 1) {
        throw new Error(DEFAULT_ASSISTANT_ERROR);
      }

      setAssistantBusy(true);
      setAssistantSurfaceError(null);

      try {
        await ensureAssigned(nextPrescriptionId, contextVersion);

        if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
          throw new Error(DEFAULT_ASSISTANT_ERROR);
        }

        const result = await polishDraftTransport(nextPrescriptionId, draft);

        if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
          throw new Error(DEFAULT_ASSISTANT_ERROR);
        }

        return result;
      } catch (error) {
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          const nextError = resolveUnknownErrorMessage(error, DEFAULT_ASSISTANT_ERROR);
          setAssistantSurfaceError(nextError);
          setAssistantEnabled(false);
          setSmartReplies([]);
        }

        if (error instanceof Error) {
          throw error;
        }

        throw new Error(resolveUnknownErrorMessage(error, DEFAULT_ASSISTANT_ERROR));
      } finally {
        if (runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId) {
          setAssistantBusy(false);
        }
      }
    };
  }, [assistantEnabled, assignReady, ensureAssigned, polishDraftTransport]);

  const onSurfaceError = useCallback((message: string | null): void => {
    const nextMessage = typeof message === 'string' && message.trim() !== ''
      ? message
      : null;
    setThreadSurfaceError(nextMessage);
  }, []);

  useEffect(() => {
    const nextPrescriptionId = normalizePrescriptionId(prescriptionId);
    prescriptionIdRef.current = nextPrescriptionId;
    invalidateConversationContext();

    if (nextPrescriptionId < 1) {
      return;
    }

    void syncThreadForPrescription(nextPrescriptionId);
  }, [invalidateConversationContext, prescriptionId, syncThreadForPrescription]);

  return {
    messages,
    messagesLoading,
    threadSurfaceError,
    assistantSurfaceError,
    assignBusy,
    assignReady,
    assistantEnabled,
    assistantBusy,
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
    invalidateConversationContext,
  };
}
