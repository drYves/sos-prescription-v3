import type {
  DoctorMessagingThreadLoadRequest,
  MessageItem,
  SmartReplyOption,
  UploadedFile,
} from './useDoctorMessagingRuntime';

type AppConfig = {
  restBase: string;
  restV4Base?: string;
  nonce: string;
  currentUser?: {
    id?: number;
    displayName?: string;
    email?: string;
    roles?: string[] | string;
  };
};

export type ThreadState = {
  mode?: string;
  unread_count_doctor?: number;
  last_message_seq?: number;
};

type ThreadPayload = {
  messages?: MessageItem[];
  message?: MessageItem;
  thread_state?: ThreadState;
  unchanged?: boolean;
};

type CanonicalThreadKind = 'snapshot' | 'delta' | 'unchanged';

type CanonicalThreadPayload = {
  kind: CanonicalThreadKind;
  messages: MessageItem[];
  threadState: ThreadState;
  unchanged: boolean;
};

type ThreadMessageCarrier = {
  messages: MessageItem[];
  hasCarrier: boolean;
  invalidCarrier: boolean;
};

type ThreadStateSelection = {
  threadState: ThreadState;
  hasState: boolean;
};

type ArtifactAccessPayload = {
  access?: {
    url?: string;
  };
};

export type PolishPayload = {
  rewritten_body?: string;
  changes_summary?: string[];
  risk_flags?: string[];
};

type SmartRepliesPayload = {
  smart_replies?: {
    replies?: SmartReplyOption[];
  } | null;
  replies?: SmartReplyOption[];
};

type DoctorMessagingWindow = Window & {
  SOSPrescription?: AppConfig;
  SosPrescription?: AppConfig;
};

export type ApiRequestOptions = {
  bypassInFlightDedup?: boolean;
};

const INTERNAL_BYPASS_DEDUP_HEADER = 'X-Sos-Bypass-Dedup';
const INITIAL_THREAD_SNAPSHOT_ERROR = 'Hydratation initiale du thread impossible : snapshot manquant.';
const AMBIGUOUS_THREAD_PAYLOAD_ERROR = 'Le thread médecin a renvoyé un payload ambigu.';
const THREAD_TRANSPORT_WRAPPER_KEYS = ['data', 'result', 'payload', 'thread', 'conversation', 'response'] as const;

export function getAppConfig(): AppConfig {
  const g = window as DoctorMessagingWindow;
  const cfg = g.SOSPrescription || g.SosPrescription;
  if (!cfg || typeof cfg.restBase !== 'string' || typeof cfg.nonce !== 'string') {
    throw new Error('Configuration SosPrescription introuvable (window.SosPrescription).');
  }
  return cfg;
}

function getRestV4Base(): string {
  const cfg = getAppConfig();
  const fallbackBase = String(cfg.restBase || '').replace(/\/sosprescription\/v1\/?$/, '/sosprescription/v4').trim();
  const restV4Base = typeof cfg.restV4Base === 'string' && cfg.restV4Base.trim() !== '' ? cfg.restV4Base.trim() : fallbackBase;
  if (!restV4Base) {
    throw new Error('Configuration REST V4 absente.');
  }
  return restV4Base.replace(/\/$/, '');
}

function withCacheBuster(path: string, method: string): string {
  if (String(method).toUpperCase() !== 'GET') {
    return path;
  }

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://sosprescription.local';
    const url = new URL(path, base);
    url.searchParams.set('_ts', String(Date.now()));
    return url.pathname + url.search;
  } catch {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}_ts=${Date.now()}`;
  }
}

export function toPositiveWpUserId(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : undefined;
}

export function getCurrentWpUserId(): number | undefined {
  return toPositiveWpUserId(getAppConfig().currentUser?.id);
}

function applyInternalFetchOptions(headers: Headers, method: string, options?: ApiRequestOptions): void {
  if (String(method).toUpperCase() === 'GET' && options?.bypassInFlightDedup) {
    headers.set(INTERNAL_BYPASS_DEDUP_HEADER, '1');
  }
}

export async function apiJson<T>(path: string, init: RequestInit, scope = 'admin', options?: ApiRequestOptions): Promise<T> {
  const cfg = getAppConfig();
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('Accept', 'application/json');
  headers.set('X-Sos-Scope', scope);
  applyInternalFetchOptions(headers, method, options);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(cfg.restBase.replace(/\/$/, '') + withCacheBuster(path, method), {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? String((payload as { message: string }).message)
        : `Erreur API (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

async function v4ApiJson<T>(path: string, init: RequestInit, scope = 'admin', options?: ApiRequestOptions): Promise<T> {
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('X-WP-Nonce', getAppConfig().nonce);
  headers.set('Accept', 'application/json');
  headers.set('X-Sos-Scope', scope);
  applyInternalFetchOptions(headers, method, options);

  if (method === 'GET') {
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    headers.set('Pragma', 'no-cache');
  }

  const response = await fetch(getRestV4Base() + withCacheBuster(path, method), {
    ...init,
    method,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : init.cache,
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof (payload as { message?: unknown }).message === 'string'
        ? String((payload as { message: string }).message)
        : `Erreur API (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export function normalizeMode(value: unknown): 'DOCTOR_ONLY' | 'PATIENT_REPLY' | 'READ_ONLY' | '' {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'DOCTOR_ONLY' || normalized === 'PATIENT_REPLY' || normalized === 'READ_ONLY') {
    return normalized;
  }
  return '';
}

function toAttachmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'id' in (entry as { id?: unknown })) {
        return Number((entry as { id?: unknown }).id || 0);
      }
      return Number(entry || 0);
    })
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

export function normalizeMessage(input: Partial<MessageItem> | null | undefined): MessageItem {
  const fallbackAttachments = Array.isArray((input as { attachment_artifact_ids?: unknown } | null)?.attachment_artifact_ids)
    ? ((input as { attachment_artifact_ids: unknown[] }).attachment_artifact_ids as unknown[])
    : [];
  const attachmentsSource = Array.isArray(input?.attachments) ? input.attachments : fallbackAttachments;
  const authorWpUserId = toPositiveWpUserId(
    (input as { author_wp_user_id?: unknown; authorWpUserId?: unknown; author_user_id?: unknown; authorUserId?: unknown } | null)?.author_wp_user_id
      ?? (input as { author_wp_user_id?: unknown; authorWpUserId?: unknown; author_user_id?: unknown; authorUserId?: unknown } | null)?.authorWpUserId
      ?? (input as { author_wp_user_id?: unknown; authorWpUserId?: unknown; author_user_id?: unknown; authorUserId?: unknown } | null)?.author_user_id
      ?? (input as { author_wp_user_id?: unknown; authorWpUserId?: unknown; author_user_id?: unknown; authorUserId?: unknown } | null)?.authorUserId
  );

  return {
    id: Number(input?.id || input?.seq || Date.now()),
    seq: Number(input?.seq || 0) || undefined,
    author_role: String(input?.author_role || 'DOCTOR'),
    author_wp_user_id: authorWpUserId,
    body: String(input?.body || ''),
    created_at: String(input?.created_at || ''),
    attachments: toAttachmentIds(attachmentsSource),
  };
}

function dedupeMessages(items: MessageItem[]): MessageItem[] {
  const map = new Map<string, MessageItem>();

  items.forEach((item) => {
    const normalized = normalizeMessage(item);
    const key = normalized.id > 0
      ? `id:${normalized.id}`
      : normalized.seq && normalized.seq > 0
      ? `seq:${normalized.seq}`
      : `${normalized.author_role}:${normalized.created_at}:${normalized.body}`;
    map.set(key, normalized);
  });

  return Array.from(map.values()).sort((left, right) => {
    const leftSeq = Number(left.seq || 0);
    const rightSeq = Number(right.seq || 0);
    if (leftSeq > 0 || rightSeq > 0) {
      return leftSeq - rightSeq;
    }
    return String(left.created_at || '').localeCompare(String(right.created_at || ''));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isMessageLike(value: unknown): value is Partial<MessageItem> {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.body === 'string'
    || typeof value.created_at === 'string'
    || Number.isFinite(Number(value.id))
    || Number.isFinite(Number(value.seq))
    || Array.isArray(value.attachments)
    || Array.isArray((value as { attachment_artifact_ids?: unknown }).attachment_artifact_ids);
}

function normalizeMessagesCollection(value: unknown): MessageItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeMessages(value.filter((entry): entry is Partial<MessageItem> => isMessageLike(entry)).map((entry) => normalizeMessage(entry)));
}

function normalizeSingleMessageCandidate(value: unknown): MessageItem[] {
  return isMessageLike(value) ? [normalizeMessage(value)] : [];
}

function normalizeThreadStatePatch(value: unknown): ThreadState | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = hasOwn(value, 'thread_state')
    ? value.thread_state
    : (hasOwn(value, 'threadState') ? value.threadState : value);

  if (!isRecord(source)) {
    return null;
  }

  const patch: ThreadState = {};

  if (typeof source.mode === 'string' && source.mode.trim() !== '') {
    patch.mode = source.mode;
  }

  const unreadCountDoctor = hasOwn(source, 'unread_count_doctor')
    ? Number(source.unread_count_doctor)
    : Number(source.unreadCountDoctor);
  if (Number.isFinite(unreadCountDoctor) && unreadCountDoctor >= 0) {
    patch.unread_count_doctor = Math.trunc(unreadCountDoctor);
  }

  const lastMessageSeq = hasOwn(source, 'last_message_seq')
    ? Number(source.last_message_seq)
    : Number(source.lastMessageSeq);
  if (Number.isFinite(lastMessageSeq) && lastMessageSeq >= 0) {
    patch.last_message_seq = Math.trunc(lastMessageSeq);
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function mergeThreadState(currentThreadState: ThreadState, patch: ThreadState | null): ThreadState {
  if (!patch) {
    return currentThreadState;
  }

  return {
    ...currentThreadState,
    ...patch,
  };
}

function normalizeCanonicalThreadKind(value: unknown): CanonicalThreadKind | '' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'snapshot' || normalized === 'delta' || normalized === 'unchanged') {
    return normalized;
  }
  return '';
}

function collectThreadTransportCandidates(value: unknown): unknown[] {
  const candidates: unknown[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    candidates.push(current);

    if (Array.isArray(current)) {
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    THREAD_TRANSPORT_WRAPPER_KEYS.forEach((key) => {
      if (hasOwn(current, key)) {
        queue.push(current[key]);
      }
    });
  }

  return candidates;
}

function extractThreadMessagesFromCandidate(candidate: unknown): ThreadMessageCarrier {
  if (Array.isArray(candidate)) {
    const messages = normalizeMessagesCollection(candidate);
    return {
      messages,
      hasCarrier: true,
      invalidCarrier: candidate.length > 0 && messages.length < 1,
    };
  }

  if (!isRecord(candidate)) {
    return {
      messages: [],
      hasCarrier: false,
      invalidCarrier: false,
    };
  }

  if (hasOwn(candidate, 'messages')) {
    if (!Array.isArray(candidate.messages)) {
      return {
        messages: [],
        hasCarrier: true,
        invalidCarrier: true,
      };
    }

    const messages = normalizeMessagesCollection(candidate.messages);
    return {
      messages,
      hasCarrier: true,
      invalidCarrier: candidate.messages.length > 0 && messages.length < 1,
    };
  }

  if (hasOwn(candidate, 'message')) {
    const messages = normalizeSingleMessageCandidate(candidate.message);
    return {
      messages,
      hasCarrier: true,
      invalidCarrier: messages.length < 1,
    };
  }

  return {
    messages: [],
    hasCarrier: false,
    invalidCarrier: false,
  };
}

function selectThreadMessages(candidates: unknown[]): ThreadMessageCarrier {
  const messageCandidates = candidates.map((candidate) => extractThreadMessagesFromCandidate(candidate));
  const validCarriers = messageCandidates.filter((candidate) => candidate.hasCarrier && !candidate.invalidCarrier);
  const selectedValidCarrier = validCarriers.find((candidate) => candidate.messages.length > 0) || validCarriers[0];

  if (selectedValidCarrier) {
    return selectedValidCarrier;
  }

  const invalidCarrier = messageCandidates.find((candidate) => candidate.invalidCarrier);
  if (invalidCarrier) {
    return invalidCarrier;
  }

  return {
    messages: [],
    hasCarrier: false,
    invalidCarrier: false,
  };
}

function selectThreadState(candidates: unknown[], currentThreadState: ThreadState): ThreadStateSelection {
  for (const candidate of candidates) {
    const patch = normalizeThreadStatePatch(candidate);
    if (patch) {
      return {
        threadState: mergeThreadState(currentThreadState, patch),
        hasState: true,
      };
    }
  }

  return {
    threadState: currentThreadState,
    hasState: false,
  };
}

function selectExplicitThreadKind(candidates: unknown[]): CanonicalThreadKind | '' {
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }

    const explicitKind = normalizeCanonicalThreadKind(
      hasOwn(candidate, 'kind')
        ? candidate.kind
        : (hasOwn(candidate, 'hydrationKind') ? candidate.hydrationKind : undefined),
    );

    if (explicitKind !== '') {
      return explicitKind;
    }
  }

  return '';
}

function hasExplicitThreadUnchanged(candidates: unknown[]): boolean {
  return candidates.some((candidate) => isRecord(candidate) && hasOwn(candidate, 'unchanged') && Boolean(candidate.unchanged));
}

function getThreadStateLastMessageSeq(threadState: ThreadState): number {
  const value = Number(threadState.last_message_seq || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeThreadLoadRequest(request?: DoctorMessagingThreadLoadRequest): DoctorMessagingThreadLoadRequest {
  const hasCommittedSnapshot = Boolean(request?.hasCommittedSnapshot);
  const afterSeq = Number.isFinite(Number(request?.afterSeq)) && Number(request?.afterSeq) > 0
    ? Math.trunc(Number(request?.afterSeq))
    : 0;
  const useDeltaTransport = request?.mode === 'delta' && hasCommittedSnapshot && afterSeq > 0;

  return {
    mode: useDeltaTransport ? 'delta' : 'snapshot',
    afterSeq: useDeltaTransport ? afterSeq : 0,
    hasCommittedSnapshot,
  };
}

function createThreadTransportContractError(message: string): Error {
  return new Error(message);
}

function normalizeThreadTransportPayload(
  payload: unknown,
  request: DoctorMessagingThreadLoadRequest | undefined,
  currentThreadState: ThreadState,
): CanonicalThreadPayload {
  const normalizedRequest = normalizeThreadLoadRequest(request);
  const isIncrementalRead = normalizedRequest.mode === 'delta' && normalizedRequest.afterSeq > 0;
  const candidates = collectThreadTransportCandidates(payload);
  const explicitKind = selectExplicitThreadKind(candidates);
  const explicitUnchanged = hasExplicitThreadUnchanged(candidates);
  const messageCarrier = selectThreadMessages(candidates);
  const threadStateSelection = selectThreadState(candidates, currentThreadState);
  const nextThreadState = threadStateSelection.threadState;
  const threadStateLastMessageSeq = getThreadStateLastMessageSeq(nextThreadState);
  const hasExplicitMessages = messageCarrier.hasCarrier && !messageCarrier.invalidCarrier;
  const fetchedMessages = messageCarrier.messages;

  if (messageCarrier.invalidCarrier && !hasExplicitMessages) {
    throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
  }

  if (explicitKind === 'snapshot') {
    if (!hasExplicitMessages) {
      throw createThreadTransportContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    return {
      kind: 'snapshot',
      messages: fetchedMessages,
      threadState: nextThreadState,
      unchanged: false,
    };
  }

  if (!isIncrementalRead) {
    if (explicitKind === 'delta' || explicitKind === 'unchanged' || explicitUnchanged || !hasExplicitMessages) {
      throw createThreadTransportContractError(INITIAL_THREAD_SNAPSHOT_ERROR);
    }

    return {
      kind: 'snapshot',
      messages: fetchedMessages,
      threadState: nextThreadState,
      unchanged: false,
    };
  }

  if (explicitKind === 'delta') {
    if (hasExplicitMessages && fetchedMessages.length > 0) {
      return {
        kind: 'delta',
        messages: fetchedMessages,
        threadState: nextThreadState,
        unchanged: false,
      };
    }

    if (threadStateSelection.hasState) {
      if (threadStateLastMessageSeq > normalizedRequest.afterSeq) {
        throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
      }

      return {
        kind: 'unchanged',
        messages: [],
        threadState: nextThreadState,
        unchanged: true,
      };
    }

    if (hasExplicitMessages && fetchedMessages.length < 1) {
      return {
        kind: 'unchanged',
        messages: [],
        threadState: nextThreadState,
        unchanged: true,
      };
    }

    throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
  }

  if (explicitKind === 'unchanged' || explicitUnchanged) {
    if (hasExplicitMessages && fetchedMessages.length > 0) {
      throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    if (threadStateSelection.hasState && threadStateLastMessageSeq > normalizedRequest.afterSeq) {
      throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadState: nextThreadState,
      unchanged: true,
    };
  }

  if (hasExplicitMessages && fetchedMessages.length > 0) {
    return {
      kind: 'delta',
      messages: fetchedMessages,
      threadState: nextThreadState,
      unchanged: false,
    };
  }

  if (hasExplicitMessages && fetchedMessages.length < 1) {
    if (threadStateSelection.hasState && threadStateLastMessageSeq > normalizedRequest.afterSeq) {
      throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadState: nextThreadState,
      unchanged: true,
    };
  }

  if (threadStateSelection.hasState) {
    if (threadStateLastMessageSeq > normalizedRequest.afterSeq) {
      throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
    }

    return {
      kind: 'unchanged',
      messages: [],
      threadState: nextThreadState,
      unchanged: true,
    };
  }

  throw createThreadTransportContractError(AMBIGUOUS_THREAD_PAYLOAD_ERROR);
}

export function normalizeSmartReplies(payload: unknown): SmartReplyOption[] {
  const root = payload && typeof payload === 'object' ? (payload as SmartRepliesPayload) : null;
  const directReplies = Array.isArray(root?.replies) ? root?.replies : [];
  const nestedReplies = Array.isArray(root?.smart_replies?.replies) ? root?.smart_replies?.replies : [];
  const source = nestedReplies.length > 0 ? nestedReplies : directReplies;

  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const row = entry as SmartReplyOption;
      const body = String(row.body || '').trim();
      if (!body) {
        return null;
      }

      return {
        type: typeof row.type === 'string' ? row.type : undefined,
        title: typeof row.title === 'string' ? row.title : undefined,
        body,
      } as SmartReplyOption;
    })
    .filter((entry): entry is SmartReplyOption => entry !== null)
    .slice(0, 3);
}

function normalizePolishPayload(payload: unknown, originalDraft: string): PolishPayload {
  const candidates: unknown[] = [];
  if (payload && typeof payload === 'object') {
    const root = payload as {
      ok?: unknown;
      message?: unknown;
      rewritten_body?: unknown;
      changes_summary?: unknown;
      risk_flags?: unknown;
      data?: unknown;
      result?: unknown;
      polish?: unknown;
      payload?: unknown;
    };

    if (root.ok === false && typeof root.message === 'string' && root.message.trim() !== '') {
      throw new Error(root.message.trim());
    }

    candidates.push(payload, root.data, root.result, root.polish, root.payload);
  } else {
    candidates.push(payload);
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const row = candidate as {
      rewritten_body?: unknown;
      changes_summary?: unknown;
      risk_flags?: unknown;
    };

    const rewritten = typeof row.rewritten_body === 'string' && row.rewritten_body.trim() !== ''
      ? row.rewritten_body
      : null;
    const changesSummary = Array.isArray(row.changes_summary)
      ? row.changes_summary.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [];
    const riskFlags = Array.isArray(row.risk_flags)
      ? row.risk_flags.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [];

    if (rewritten || changesSummary.length > 0 || riskFlags.length > 0) {
      return {
        rewritten_body: rewritten || originalDraft,
        changes_summary: changesSummary,
        risk_flags: riskFlags,
      };
    }
  }

  throw new Error('Réponse inattendue du service de reformulation.');
}

async function getDoctorMessages(
  prescriptionId: number,
  afterSeq = 0,
  options?: ApiRequestOptions,
): Promise<unknown> {
  const normalizedAfterSeq = Math.max(0, Number(afterSeq || 0));
  const query = normalizedAfterSeq > 0 ? `?after_seq=${encodeURIComponent(String(normalizedAfterSeq))}` : '';
  return apiJson<unknown>(`/prescriptions/${prescriptionId}/messages${query}`, { method: 'GET' }, 'admin', options);
}

export async function loadDoctorThreadTransport(
  prescriptionId: number,
  request: DoctorMessagingThreadLoadRequest | undefined,
  currentThreadState: ThreadState,
  options?: ApiRequestOptions,
): Promise<CanonicalThreadPayload> {
  const normalizedRequest = normalizeThreadLoadRequest(request);
  const payload = await getDoctorMessages(prescriptionId, normalizedRequest.afterSeq, options);
  return normalizeThreadTransportPayload(payload, normalizedRequest, currentThreadState);
}

export async function postDoctorMessage(prescriptionId: number, body: string, attachments?: number[]): Promise<MessageItem> {
  const payload = await apiJson<ThreadPayload>(
    `/prescriptions/${prescriptionId}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body,
        attachment_artifact_ids: Array.isArray(attachments) && attachments.length > 0 ? attachments : undefined,
      }),
    },
    'admin',
  );

  return normalizeMessage(payload && payload.message ? payload.message : {
    id: Date.now(),
    author_role: 'DOCTOR',
    author_wp_user_id: getCurrentWpUserId(),
    body,
    created_at: new Date().toISOString(),
    attachments,
  });
}

export async function markDoctorMessagesRead(prescriptionId: number, readUptoSeq: number): Promise<ThreadPayload> {
  return apiJson<ThreadPayload>(
    `/prescriptions/${prescriptionId}/messages/read`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read_upto_seq: Math.max(0, Number(readUptoSeq || 0)) }),
    },
    'admin',
  );
}

export async function requestArtifactAccess(artifactId: number, prescriptionId: number): Promise<ArtifactAccessPayload> {
  return apiJson<ArtifactAccessPayload>(
    `/artifacts/${encodeURIComponent(String(artifactId))}/access`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prescription_id: prescriptionId,
        disposition: 'attachment',
      }),
    },
    'admin',
  );
}

export async function polishDoctorMessage(prescriptionId: number, draft: string): Promise<PolishPayload> {
  const normalizedPrescriptionId = Math.max(0, Number(prescriptionId || 0));
  const sourceDraft = String(draft || '').trim();

  if (normalizedPrescriptionId < 1) {
    throw new Error('Contexte dossier manquant pour l’assistance IA.');
  }

  if (sourceDraft === '') {
    throw new Error('Message vide.');
  }

  const actorWpUserId = getCurrentWpUserId();
  const transportContext = {
    local_prescription_id: normalizedPrescriptionId,
    surface: 'doctor_messaging',
  };

  try {
    const payload = await v4ApiJson<unknown>(
      '/messages/polish',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prescription_id: normalizedPrescriptionId,
          prescriptionId: normalizedPrescriptionId,
          local_prescription_id: normalizedPrescriptionId,
          context: transportContext,
          actor_role: 'DOCTOR',
          actor_wp_user_id: actorWpUserId,
          draft: sourceDraft,
          constraints: {
            audience: 'patient',
            tone: 'professional',
            language: 'fr',
            preserveDecision: true,
            forceClarificationIfAmbiguous: true,
            context: transportContext,
          },
        }),
      },
      'admin',
    );

    return normalizePolishPayload(payload, sourceDraft);
  } catch (error) {
    try {
      console.error('Doctor messaging polish failed', error);
    } catch {
      // Ignore console failures.
    }

    if (error instanceof Error && error.message.trim() !== '') {
      throw error;
    }

    throw new Error('Aide à la rédaction momentanément indisponible.');
  }
}

export async function getDoctorSmartReplies(prescriptionId: number): Promise<SmartRepliesPayload> {
  return v4ApiJson<SmartRepliesPayload>(`/prescriptions/${prescriptionId}/smart-replies`, { method: 'GET' }, 'admin');
}

export function findDoctorMessagingHost(prescriptionId: number): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector(`[data-sp-doctor-chat-root="1"][data-prescription-id="${String(prescriptionId)}"]`);
}

export function normalizeDoctorSelectedStatus(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

export type { UploadedFile };
