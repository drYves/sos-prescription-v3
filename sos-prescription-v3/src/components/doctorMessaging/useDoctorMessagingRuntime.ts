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

export type DoctorMessagingThreadHydrationKind = 'snapshot' | 'delta' | 'unchanged';

export type DoctorMessagingThreadLoadMode = 'snapshot' | 'delta';

export type DoctorMessagingThreadLoadRequest = {
  mode: DoctorMessagingThreadLoadMode;
  afterSeq: number;
  hasCommittedSnapshot: boolean;
};

export type DoctorMessagingThreadHydrationResult = {
  kind: DoctorMessagingThreadHydrationKind;
  messages?: MessageItem[];
  threadState?: {
    lastMessageSeq?: number;
  };
  canCompose?: boolean;
  readOnlyNotice?: string;
  emptyText?: string;
  subtitle?: string;
  smartReplies?: SmartReplyOption[];
  assistantEnabled?: boolean;
};

type DoctorMessagingThreadTransportResult = DoctorMessagingThreadPayload | DoctorMessagingThreadHydrationResult | MessageItem[];

type ThreadSurfacePatch = Partial<Pick<DoctorMessagingThreadPayload, 'canCompose' | 'readOnlyNotice' | 'emptyText' | 'subtitle' | 'smartReplies' | 'assistantEnabled'>>;

type NormalizedThreadHydration = {
  kind: DoctorMessagingThreadHydrationKind;
  messages: MessageItem[];
  threadStateLastMessageSeq?: number;
  surfacePatch: ThreadSurfacePatch;
};

type ThreadTransportContext = {
  request: DoctorMessagingThreadLoadRequest;
  hasCommittedSnapshot: boolean;
};

type ThreadSurfaceState = {
  canCompose: boolean;
  readOnlyNotice: string;
  emptyText: string;
  subtitle: string;
  smartReplies: SmartReplyOption[];
  assistantEnabled: boolean;
};

export type UseDoctorMessagingRuntimeArgs = {
  prescriptionId: number | null;
  assignConversation: (prescriptionId: number) => Promise<unknown>;
  loadThread: (prescriptionId: number, request?: DoctorMessagingThreadLoadRequest) => Promise<DoctorMessagingThreadTransportResult>;
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
const INITIAL_THREAD_SNAPSHOT_ERROR = 'Hydratation initiale du thread impossible : snapshot manquant.';
const AMBIGUOUS_THREAD_PAYLOAD_ERROR = 'Le thread médecin a renvoyé un payload ambigu.';

function createDefaultThreadSurfaceState(): ThreadSurfaceState {
  return {
    canCompose: false,
    readOnlyNotice: DEFAULT_READ_ONLY_NOTICE,
    emptyText: DEFAULT_EMPTY_TEXT,
    subtitle: DEFAULT_SUBTITLE,
    smartReplies: [],
    assistantEnabled: false,
  };
}

function normalizePrescriptionId(value: number | null | undefined): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

    const data = (response as { data?: unknown }).data;
    if (isRecord(data)) {
      const dataStatus = Number((data as { status?: unknown }).status);
      if (Number.isFinite(dataStatus) && dataStatus > 0) {
        return Math.trunc(dataStatus);
      }
    }
  }

  const message = resolveUnknownErrorMessage(error, '');
  const messageMatch = message.match(/\b409\b/);
  if (messageMatch) {
    return 409;
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

  if (status === 409) {
    return true;
  }

  return (
    code.includes('already_assigned')
    || code.includes('already-assigned')
    || code.includes('conversation_already_assigned')
    || code.includes('assignment_conflict')
    || code.includes('assign_conflict')
    || code.includes('claim_conflict')
    || message.includes('erreur api (409)')
    || message.includes('409 conflict')
    || (message.includes('409') && message.includes('assign'))
    || message.includes('already assigned')
    || message.includes('déjà assign')
    || message.includes('deja assign')
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

function normalizeThreadSurfacePatch(input: Record<string, unknown>): ThreadSurfacePatch {
  const patch: ThreadSurfacePatch = {};

  if (hasOwn(input, 'canCompose')) {
    patch.canCompose = Boolean((input as { canCompose?: unknown }).canCompose);
  }

  if (hasOwn(input, 'readOnlyNotice')) {
    patch.readOnlyNotice = normalizeText((input as { readOnlyNotice?: unknown }).readOnlyNotice, DEFAULT_READ_ONLY_NOTICE);
  }

  if (hasOwn(input, 'emptyText')) {
    patch.emptyText = normalizeText((input as { emptyText?: unknown }).emptyText, DEFAULT_EMPTY_TEXT);
  }

  if (hasOwn(input, 'subtitle')) {
    patch.subtitle = normalizeText((input as { subtitle?: unknown }).subtitle, DEFAULT_SUBTITLE);
  }

  if (hasOwn(input, 'smartReplies')) {
    patch.smartReplies = normalizeSmartReplies((input as { smartReplies?: unknown }).smartReplies);
  }

  if (hasOwn(input, 'assistantEnabled')) {
    patch.assistantEnabled = Boolean((input as { assistantEnabled?: unknown }).assistantEnabled);
  }

  return patch;
}

function normalizeThreadStateLastMessageSeq(input: Record<string, unknown>): number | undefined {
  const threadState = hasOwn(input, 'threadState')
    ? (input as { threadState?: unknown }).threadState
    : (hasOwn(input, 'thread_state') ? (input as { thread_state?: unknown }).thread_state : undefined);

  if (!isRecord(threadState)) {
    return undefined;
  }

  const raw = hasOwn(threadState, 'lastMessageSeq')
    ? Number((threadState as { lastMessageSeq?: unknown }).lastMessageSeq)
    : Number((threadState as { last_message_seq?: unknown }).last_message_seq);

  if (!Number.isFinite(raw) || raw < 0) {
    return undefined;
  }

  return Math.trunc(raw);
}

function deriveLastMessageSeq(messages: MessageItem[]): number {
  return messages.reduce((maxValue, message) => {
    const nextSeq = Number(message.seq || 0);
    if (!Number.isFinite(nextSeq) || nextSeq < 1) {
      return maxValue;
    }

    return Math.max(maxValue, Math.trunc(nextSeq));
  }, 0);
}

function resolveThreadLastMessageSeq(messages: MessageItem[], threadStateLastMessageSeq?: number): number {
  const derived = deriveLastMessageSeq(messages);
  const fromState = Number.isFinite(Number(threadStateLastMessageSeq)) && Number(threadStateLastMessageSeq) > 0
    ? Math.trunc(Number(threadStateLastMessageSeq))
    : 0;

  return Math.max(derived, fromState);
}

function createThreadContractError(message: string): Error {
  return new Error(message);
}

function normalizeExplicitHydrationKind(input: Record<string, unknown>): DoctorMessagingThreadHydrationKind | '' {
  const candidates = [
    normalizeText((input as { kind?: unknown }).kind).trim().toLowerCase(),
    normalizeText((input as { hydrationKind?: unknown }).hydrationKind).trim().toLowerCase(),
  ];

  for (const candidate of candidates) {
    if (candidate === 'snapshot' || candidate === 'delta' || candidate === 'unchanged') {
      return candidate;
    }
  }

  return '';
}

function normalizeLegacyArrayPayload(messages: MessageItem[], context: ThreadTransportContext): NormalizedThreadHydration {
  if (!context.hasCommittedSnapshot || context.request.mode === 'snapshot' || context.request.afterSeq < 1) {
    return {
      kind: 'snapshot',
      messages,
      surfacePatch: {},
    };
  }

  if (messages.length > 0) {
    return {
      kind: 'delta',
      messages,
      surfacePatch: {},
    };
  }

  return {
    kind: 'unchanged',
    messages: [],
    surfacePatch: {},
  };
}

function normalizeThreadTransportResult(input: DoctorMessagingThreadTransportResult | unknown, context: ThreadTransportContext): NormalizedThreadHydration {
  if (Array.isArray(input)) {
    return normalizeLegacyArrayPayload(normalizeMessages(input), context);
  }

  if (!isRecord(input)) {
    throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
  }

  const explicitKind = normalizeExplicitHydrationKind(input);
  const surfacePatch = normalizeThreadSurfacePatch(input);
  const threadStateLastMessageSeq = normalizeThreadStateLastMessageSeq(input);
  const hasMessagesProperty = hasOwn(input, 'messages');
  const normalizedMessages = hasMessagesProperty
    ? normalizeMessages((input as { messages?: unknown }).messages)
    : [];
  const hasSingleMessageProperty = hasOwn(input, 'message');
  const normalizedSingleMessage = hasSingleMessageProperty
    ? normalizeMessages([(input as { message?: unknown }).message])
    : [];
  const candidateMessages = hasMessagesProperty ? normalizedMessages : normalizedSingleMessage;
  const hasCandidateMessages = hasMessagesProperty || (hasSingleMessageProperty && normalizedSingleMessage.length > 0);
  const explicitUnchanged = hasOwn(input, 'unchanged') && Boolean((input as { unchanged?: unknown }).unchanged);

  if (explicitKind === 'snapshot') {
    if (!hasMessagesProperty && normalizedSingleMessage.length < 1) {
      throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    return {
      kind: 'snapshot',
      messages: candidateMessages,
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (explicitKind === 'delta') {
    if (!context.hasCommittedSnapshot) {
      throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    if (candidateMessages.length > 0) {
      return {
        kind: 'delta',
        messages: candidateMessages,
        threadStateLastMessageSeq,
        surfacePatch,
      };
    }

    if (typeof threadStateLastMessageSeq === 'number' && threadStateLastMessageSeq > context.request.afterSeq) {
      throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (explicitKind === 'unchanged' || explicitUnchanged) {
    if (!context.hasCommittedSnapshot) {
      throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    if (candidateMessages.length > 0) {
      throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    if (typeof threadStateLastMessageSeq === 'number' && threadStateLastMessageSeq > context.request.afterSeq) {
      throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (!hasCandidateMessages) {
    if (typeof threadStateLastMessageSeq !== 'number') {
      throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    if (!context.hasCommittedSnapshot) {
      throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    if (threadStateLastMessageSeq > context.request.afterSeq) {
      throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (context.request.mode === 'snapshot') {
    if (!hasMessagesProperty && normalizedSingleMessage.length < 1) {
      throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    return {
      kind: 'snapshot',
      messages: candidateMessages,
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (!context.hasCommittedSnapshot) {
    throw createThreadContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
  }

  if (candidateMessages.length > 0) {
    return {
      kind: 'delta',
      messages: candidateMessages,
      threadStateLastMessageSeq,
      surfacePatch,
    };
  }

  if (typeof threadStateLastMessageSeq === 'number' && threadStateLastMessageSeq > context.request.afterSeq) {
    throw createThreadContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
  }

  return {
    kind: 'unchanged',
    messages: [],
    threadStateLastMessageSeq,
    surfacePatch,
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

function mergeMessageItems(previous: MessageItem[], nextMessages: MessageItem[]): MessageItem[] {
  return nextMessages.reduce((current, message) => mergeMessageItem(current, message), previous);
}

function buildThreadLoadRequest(hasCommittedSnapshot: boolean, afterSeq: number): DoctorMessagingThreadLoadRequest {
  const normalizedAfterSeq = Number.isFinite(Number(afterSeq)) && Number(afterSeq) > 0
    ? Math.trunc(Number(afterSeq))
    : 0;

  return {
    mode: hasCommittedSnapshot && normalizedAfterSeq > 0 ? 'delta' : 'snapshot',
    afterSeq: hasCommittedSnapshot && normalizedAfterSeq > 0 ? normalizedAfterSeq : 0,
    hasCommittedSnapshot,
  };
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
  const assigningIdRef = useRef(0);
  const assignInFlightRef = useRef<Map<number, Promise<boolean>>>(new Map());
  const threadRequestIdRef = useRef(0);
  const committedMessagesRef = useRef<MessageItem[]>([]);
  const committedSnapshotSeqRef = useRef(0);
  const hasCommittedSnapshotRef = useRef(false);
  const surfaceStateRef = useRef<ThreadSurfaceState>(createDefaultThreadSurfaceState());

  const invalidateConversationContext = useCallback((): void => {
    runtimeVersionRef.current += 1;
    threadRequestIdRef.current += 1;
    assigningIdRef.current = 0;
    committedMessagesRef.current = [];
    committedSnapshotSeqRef.current = 0;
    hasCommittedSnapshotRef.current = false;
    surfaceStateRef.current = createDefaultThreadSurfaceState();
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

  const applyThreadHydration = useCallback((hydration: NormalizedThreadHydration, ready: boolean): void => {
    let nextMessages = committedMessagesRef.current;

    if (hydration.kind === 'snapshot') {
      nextMessages = hydration.messages;
      committedMessagesRef.current = nextMessages;
      hasCommittedSnapshotRef.current = true;
      committedSnapshotSeqRef.current = resolveThreadLastMessageSeq(nextMessages, hydration.threadStateLastMessageSeq);
      setMessages(nextMessages);
    } else if (hydration.kind === 'delta') {
      nextMessages = mergeMessageItems(committedMessagesRef.current, hydration.messages);
      committedMessagesRef.current = nextMessages;
      hasCommittedSnapshotRef.current = true;
      committedSnapshotSeqRef.current = resolveThreadLastMessageSeq(nextMessages, hydration.threadStateLastMessageSeq);
      setMessages(nextMessages);
    } else if (typeof hydration.threadStateLastMessageSeq === 'number' && hydration.threadStateLastMessageSeq > committedSnapshotSeqRef.current) {
      committedSnapshotSeqRef.current = hydration.threadStateLastMessageSeq;
    }

    const currentSurface = surfaceStateRef.current;
    const hasCanCompose = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'canCompose');
    const hasReadOnlyNotice = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'readOnlyNotice');
    const hasEmptyText = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'emptyText');
    const hasSubtitle = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'subtitle');
    const hasSmartReplies = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'smartReplies');
    const hasAssistantAdvertised = Object.prototype.hasOwnProperty.call(hydration.surfacePatch, 'assistantEnabled');

    const nextCanCompose = hasCanCompose
      ? Boolean(hydration.surfacePatch.canCompose)
      : currentSurface.canCompose;
    const nextReadOnlyNotice = hasReadOnlyNotice
      ? normalizeText(hydration.surfacePatch.readOnlyNotice, DEFAULT_READ_ONLY_NOTICE)
      : currentSurface.readOnlyNotice;
    const nextEmptyText = hasEmptyText
      ? normalizeText(hydration.surfacePatch.emptyText, DEFAULT_EMPTY_TEXT)
      : currentSurface.emptyText;
    const nextSubtitle = hasSubtitle
      ? normalizeText(hydration.surfacePatch.subtitle, DEFAULT_SUBTITLE)
      : currentSurface.subtitle;

    let nextSmartReplies = hasSmartReplies
      ? normalizeSmartReplies(hydration.surfacePatch.smartReplies)
      : currentSurface.smartReplies;
    const nextAssistantAdvertised = hasAssistantAdvertised
      ? Boolean(hydration.surfacePatch.assistantEnabled)
      : currentSurface.assistantEnabled;

    if (hasAssistantAdvertised && !nextAssistantAdvertised && !hasSmartReplies) {
      nextSmartReplies = [];
    }

    const effectiveAssistantEnabled = Boolean(nextAssistantAdvertised && ready && polishDraftTransport);

    surfaceStateRef.current = {
      canCompose: nextCanCompose,
      readOnlyNotice: nextReadOnlyNotice,
      emptyText: nextEmptyText,
      subtitle: nextSubtitle,
      smartReplies: nextSmartReplies,
      assistantEnabled: nextAssistantAdvertised,
    };

    setCanCompose(nextCanCompose);
    setReadOnlyNotice(nextReadOnlyNotice);
    setEmptyText(nextEmptyText);
    setSubtitle(nextSubtitle);
    setAssistantEnabled(effectiveAssistantEnabled);
    setSmartReplies(effectiveAssistantEnabled ? nextSmartReplies : []);
  }, [polishDraftTransport]);

  const ensureAssigned = useCallback(
    async (nextPrescriptionId: number, contextVersion: number): Promise<boolean> => {
      if (nextPrescriptionId < 1) {
        return false;
      }

      const isCurrentContext = (): boolean => runtimeVersionRef.current === contextVersion && prescriptionIdRef.current === nextPrescriptionId;

      const awaitAssignPromise = async (assignPromise: Promise<boolean>): Promise<boolean> => {
        if (isCurrentContext()) {
          setAssignBusy(true);
        }

        try {
          const ready = await assignPromise;
          if (!isCurrentContext()) {
            return false;
          }
          setAssignReady(ready);
          setThreadSurfaceError(null);
          return ready;
        } catch (error) {
          if (isBenignAssignConflict(error)) {
            if (!isCurrentContext()) {
              return false;
            }
            setAssignReady(true);
            setThreadSurfaceError(null);
            return true;
          }

          if (!isCurrentContext()) {
            return false;
          }

          setAssignReady(false);
          setThreadSurfaceError(resolveUnknownErrorMessage(error, DEFAULT_THREAD_ERROR));
          throw error;
        } finally {
          if (isCurrentContext()) {
            setAssignBusy(false);
          }
        }
      };

      const existingPromise = assignInFlightRef.current.get(nextPrescriptionId);
      if (assigningIdRef.current === nextPrescriptionId && existingPromise) {
        return awaitAssignPromise(existingPromise);
      }

      if (existingPromise) {
        assigningIdRef.current = nextPrescriptionId;
        return awaitAssignPromise(existingPromise);
      }

      assigningIdRef.current = nextPrescriptionId;

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
          if (assigningIdRef.current === nextPrescriptionId) {
            assigningIdRef.current = 0;
          }
        }
      })();

      assignInFlightRef.current.set(nextPrescriptionId, assignPromise);
      return awaitAssignPromise(assignPromise);
    },
    [assignConversation],
  );

  const syncThreadForPrescription = useCallback(
    async (nextPrescriptionId: number): Promise<void> => {
      if (nextPrescriptionId < 1) {
        return;
      }

      const contextVersion = runtimeVersionRef.current;
      const requestId = threadRequestIdRef.current + 1;
      threadRequestIdRef.current = requestId;

      const isCurrentRequest = (): boolean => (
        runtimeVersionRef.current === contextVersion
        && prescriptionIdRef.current === nextPrescriptionId
        && threadRequestIdRef.current === requestId
      );

      setMessagesLoading(true);

      try {
        const ready = await ensureAssigned(nextPrescriptionId, contextVersion);
        if (!ready || !isCurrentRequest()) {
          return;
        }

        const loadRequest = buildThreadLoadRequest(hasCommittedSnapshotRef.current, committedSnapshotSeqRef.current);
        const payload = normalizeThreadTransportResult(
          await loadThread(nextPrescriptionId, loadRequest),
          {
            request: loadRequest,
            hasCommittedSnapshot: loadRequest.hasCommittedSnapshot,
          },
        );

        if (!isCurrentRequest()) {
          return;
        }

        applyThreadHydration(payload, ready);
        setThreadSurfaceError(null);
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }

        setThreadSurfaceError(resolveUnknownErrorMessage(error, DEFAULT_THREAD_ERROR));
      } finally {
        if (isCurrentRequest()) {
          setMessagesLoading(false);
        }
      }
    },
    [applyThreadHydration, ensureAssigned, loadThread],
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
      const ready = await ensureAssigned(nextPrescriptionId, contextVersion);
      if (!ready) {
        throw new Error(DEFAULT_THREAD_ERROR);
      }

      if (runtimeVersionRef.current !== contextVersion || prescriptionIdRef.current !== nextPrescriptionId) {
        throw new Error(DEFAULT_THREAD_ERROR);
      }

      return postMessageTransport(nextPrescriptionId, body, attachments);
    },
    [ensureAssigned, postMessageTransport],
  );

  const onMessageCreated = useCallback(
    async (message: MessageItem): Promise<void> => {
      const nextMessages = mergeMessageItems(committedMessagesRef.current, [message]);
      committedMessagesRef.current = nextMessages;
      hasCommittedSnapshotRef.current = true;
      committedSnapshotSeqRef.current = resolveThreadLastMessageSeq(nextMessages);
      setMessages(nextMessages);
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
        const ready = await ensureAssigned(nextPrescriptionId, contextVersion);
        if (!ready) {
          throw new Error(DEFAULT_ASSISTANT_ERROR);
        }

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

