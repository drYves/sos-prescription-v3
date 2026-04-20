// DoctorMessagingApp.tsx · V9.0.1
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageThread from './messaging/MessageThread';

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

type ViewerRole = 'DOCTOR';

type UploadedFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  mime_type?: string;
  size_bytes?: number;
  download_url?: string;
};

type MessageItem = {
  id: number;
  seq?: number;
  author_role: string;
  author_wp_user_id?: number;
  body: string;
  created_at: string;
  attachments?: number[];
};

type ThreadState = {
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

type ArtifactAccessPayload = {
  access?: {
    url?: string;
  };
};

type PolishPayload = {
  rewritten_body?: string;
  changes_summary?: string[];
  risk_flags?: string[];
};

type SmartReplyOption = {
  type?: string;
  title?: string;
  body: string;
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

const POLL_VISIBLE_MS = 15000;
const POLL_HIDDEN_MS = 30000;
const POLL_VISIBLE_STABLE_MS = 30000;
const POLL_VISIBLE_IDLE_MS = 60000;
const DOCTOR_EXPLICIT_REFRESH_DEBOUNCE_MS = 160;
const DOCTOR_EXPLICIT_REFRESH_MIN_INTERVAL_MS = 1200;
const INTERNAL_BYPASS_DEDUP_HEADER = 'X-Sos-Bypass-Dedup';

type ThreadRefreshReason = 'bootstrap' | 'poll' | 'message-created' | 'visibility' | 'focus' | 'interaction';

type ApiRequestOptions = {
  bypassInFlightDedup?: boolean;
};

type ThreadRefreshRequest = {
  silent: boolean;
  reason: ThreadRefreshReason;
  bypassInFlightDedup: boolean;
};

type DoctorMessagingHostElement = HTMLElement & {
  dataset: DOMStringMap;
};

function findDoctorMessagingHost(prescriptionId: number): DoctorMessagingHostElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  return document.querySelector(`[data-sp-doctor-chat-root="1"][data-prescription-id="${String(prescriptionId)}"]`) as DoctorMessagingHostElement | null;
}

function normalizeDoctorSelectedStatus(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function isDoctorStableSelectionStatus(value: unknown): boolean {
  const normalized = normalizeDoctorSelectedStatus(value);
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

function getLastKnownMessageSeq(messages: MessageItem[], nextThreadState: ThreadState): number {
  const lastMessageSeq = messages.reduce((maxValue, item) => {
    const nextValue = Number(item.seq || 0);
    return nextValue > maxValue ? nextValue : maxValue;
  }, 0);

  return Math.max(lastMessageSeq, Number(nextThreadState.last_message_seq || 0), 0);
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

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function getAppConfig(): AppConfig {
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

function toPositiveWpUserId(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : undefined;
}

function getCurrentWpUserId(): number | undefined {
  return toPositiveWpUserId(getAppConfig().currentUser?.id);
}

function applyInternalFetchOptions(headers: Headers, method: string, options?: ApiRequestOptions): void {
  if (String(method).toUpperCase() === 'GET' && options?.bypassInFlightDedup) {
    headers.set(INTERNAL_BYPASS_DEDUP_HEADER, '1');
  }
}

async function apiJson<T>(path: string, init: RequestInit, scope = 'admin', options?: ApiRequestOptions): Promise<T> {
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

function normalizeMode(value: unknown): 'DOCTOR_ONLY' | 'PATIENT_REPLY' | 'READ_ONLY' | '' {
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

function normalizeMessage(input: Partial<MessageItem> | null | undefined): MessageItem {
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

function normalizeSmartReplies(payload: unknown): SmartReplyOption[] {
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
      } satisfies SmartReplyOption;
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
): Promise<ThreadPayload> {
  const normalizedAfterSeq = Math.max(0, Number(afterSeq || 0));
  const query = normalizedAfterSeq > 0 ? `?after_seq=${encodeURIComponent(String(normalizedAfterSeq))}` : '';
  return apiJson<ThreadPayload>(`/prescriptions/${prescriptionId}/messages${query}`, { method: 'GET' }, 'admin', options);
}

async function postDoctorMessage(prescriptionId: number, body: string, attachments?: number[]): Promise<MessageItem> {
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

async function markDoctorMessagesRead(prescriptionId: number, readUptoSeq: number): Promise<ThreadPayload> {
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

async function requestArtifactAccess(artifactId: number, prescriptionId: number): Promise<ArtifactAccessPayload> {
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

async function polishDoctorMessage(draft: string): Promise<PolishPayload> {
  const sourceDraft = String(draft || '').trim();
  if (sourceDraft === '') {
    throw new Error('Message vide.');
  }

  try {
    const payload = await v4ApiJson<unknown>(
      '/messages/polish',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft: sourceDraft,
          constraints: {
            audience: 'patient',
            tone: 'professional',
            language: 'fr',
            preserveDecision: true,
            forceClarificationIfAmbiguous: true,
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

async function getDoctorSmartReplies(prescriptionId: number): Promise<SmartRepliesPayload> {
  return v4ApiJson<SmartRepliesPayload>(`/prescriptions/${prescriptionId}/smart-replies`, { method: 'GET' }, 'admin');
}

function InlineSpinner() {
  return <span className="sp-spinner" aria-label="Chargement" />;
}

function Notice({
  variant = 'info',
  children,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return <div className={cx('sp-alert', `sp-alert--${variant}`)}>{children}</div>;
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

export default function DoctorMessagingApp({ prescriptionId }: { prescriptionId: number }) {
  const cfg = getAppConfig();
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [threadState, setThreadState] = useState<ThreadState>({});
  const [files] = useState<Record<number, UploadedFile>>({});
  const [smartReplies, setSmartReplies] = useState<SmartReplyOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(typeof document !== 'undefined' ? document.hidden : false);
  const [selectedStatus, setSelectedStatus] = useState<string>(() => normalizeDoctorSelectedStatus(findDoctorMessagingHost(prescriptionId)?.dataset.prescriptionStatus || ''));

  const requestRef = useRef(0);
  const smartRepliesRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const markReadSeqRef = useRef(0);
  const interactionRefreshAtRef = useRef(0);
  const loadThreadPromiseRef = useRef<Promise<void> | null>(null);
  const pendingThreadRefreshRef = useRef<ThreadRefreshRequest | null>(null);
  const scheduledThreadRefreshRef = useRef<ThreadRefreshRequest | null>(null);
  const explicitRefreshTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<MessageItem[]>([]);
  const threadStateRef = useRef<ThreadState>({});
  const threadPollTimerRef = useRef<number | null>(null);
  const threadUnchangedCountRef = useRef(0);
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
    messagesRef.current = messages;
  }, [messages]);

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

  const loadSmartReplies = useCallback(async (): Promise<void> => {
    const requestId = smartRepliesRequestRef.current + 1;
    smartRepliesRequestRef.current = requestId;

    try {
      const payload = await getDoctorSmartReplies(prescriptionId);
      if (!mountedRef.current || smartRepliesRequestRef.current !== requestId) {
        return;
      }
      setSmartReplies(normalizeSmartReplies(payload));
    } catch {
      if (!mountedRef.current || smartRepliesRequestRef.current !== requestId) {
        return;
      }
      setSmartReplies([]);
    }
  }, [prescriptionId]);

  const loadThreadNow = useCallback(async (silent = false, options?: ApiRequestOptions): Promise<void> => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    if (!silent) {
      setLoading(true);
    }

    try {
      const currentMessages = messagesRef.current;
      const currentThreadState = threadStateRef.current;
      const currentLastKnownSeq = getLastKnownMessageSeq(currentMessages, currentThreadState);
      const payload = await getDoctorMessages(prescriptionId, currentLastKnownSeq, options);
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }

      const deltaMessages = dedupeMessages(Array.isArray(payload?.messages) ? payload.messages : []);
      const nextThreadState = payload && payload.thread_state ? payload.thread_state : currentThreadState;
      const nextMessages = currentLastKnownSeq > 0
        ? dedupeMessages(currentMessages.concat(deltaMessages))
        : deltaMessages;
      const nextLastKnownSeq = getLastKnownMessageSeq(nextMessages, nextThreadState);
      const messagesChanged = nextMessages.length !== currentMessages.length || nextLastKnownSeq !== currentLastKnownSeq;
      const unchanged = Boolean(payload?.unchanged) || (!messagesChanged && deltaMessages.length < 1);

      messagesRef.current = nextMessages;
      threadStateRef.current = nextThreadState;
      threadUnchangedCountRef.current = unchanged ? threadUnchangedCountRef.current + 1 : 0;

      setMessages(nextMessages);
      setThreadState(nextThreadState);
      setError(null);

      if (smartRepliesRequestRef.current === 0 || messagesChanged) {
        void loadSmartReplies();
      }

      if (Number(nextThreadState.unread_count_doctor || 0) > 0) {
        void markReadIfNeeded(nextThreadState);
      }
    } catch (err) {
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Impossible de charger la messagerie.');
    } finally {
      if (!silent && mountedRef.current && requestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [loadSmartReplies, markReadIfNeeded, prescriptionId]);

  const runThreadRefresh = useCallback(async function runThreadRefreshImpl(next: ThreadRefreshRequest): Promise<void> {
    if (loadThreadPromiseRef.current) {
      pendingThreadRefreshRef.current = mergeThreadRefreshRequest(pendingThreadRefreshRef.current, next);
      await loadThreadPromiseRef.current;
      return;
    }

    const refreshPromise = loadThreadNow(next.silent, {
      bypassInFlightDedup: next.bypassInFlightDedup,
    }).finally(() => {
      if (loadThreadPromiseRef.current !== refreshPromise) {
        return;
      }

      loadThreadPromiseRef.current = null;

      const pending = pendingThreadRefreshRef.current;
      pendingThreadRefreshRef.current = null;

      if (!mountedRef.current || !pending) {
        return;
      }

      void runThreadRefreshImpl(pending);
    });

    loadThreadPromiseRef.current = refreshPromise;
    await refreshPromise;
  }, [loadThreadNow]);

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
    requestRef.current = 0;
    smartRepliesRequestRef.current = 0;
    markReadSeqRef.current = 0;
    interactionRefreshAtRef.current = 0;
    loadThreadPromiseRef.current = null;
    pendingThreadRefreshRef.current = null;
    messagesRef.current = [];
    threadStateRef.current = {};
    threadUnchangedCountRef.current = 0;
    clearExplicitRefreshTimer();
    clearThreadPollTimer();
    setMessages([]);
    setThreadState({});
    setSmartReplies([]);
    setError(null);
    setFlash(null);
    setLoading(false);

    requestThreadRefresh({
      silent: false,
      reason: 'bootstrap',
    });

    return () => {
      mountedRef.current = false;
      clearExplicitRefreshTimer();
    };
  }, [clearExplicitRefreshTimer, clearThreadPollTimer, prescriptionId, requestThreadRefresh]);

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
    setMessages((current) => dedupeMessages(current.concat([normalizeMessage(message)])));
    setFlash('Message envoyé.');
    await runThreadRefresh({
      silent: true,
      reason: 'message-created',
      bypassInFlightDedup: true,
    });
  }, [runThreadRefresh]);

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
      setError(err instanceof Error ? err.message : 'Impossible de télécharger le document.');
    }
  }, [fileIndex, prescriptionId]);

  return (
    <div ref={surfaceRef} className="sp-card dc-message-react-panel">
      {flash ? <Notice variant="success">{flash}</Notice> : null}
      {error ? <Notice variant="error">{error}</Notice> : null}
      {modeNotice ? <Notice variant="info">{modeNotice}</Notice> : null}


      <div className="sp-top-gap">
        <MessageThread
          prescriptionId={prescriptionId}
          viewerRole={viewerRole}
          currentUserRoles={currentUserRoles}
          title="Échanges avec le patient"
          subtitle="Initiez ici l’échange sécurisé avec le patient si une précision médicale ou documentaire est nécessaire."
          loading={loading}
          emptyText="Aucun message pour le moment."
          messages={messages}
          fileIndex={fileIndex}
          onDownloadFile={handleAttachmentDownload}
          canCompose={mode !== 'READ_ONLY'}
          readOnlyNotice="La messagerie est en lecture seule pour ce dossier."
          postMessage={postDoctorMessage}
          onMessageCreated={handleMessageCreated}
          onSurfaceError={setError}
          enablePolish
          onPolishDraft={polishDoctorMessage}
          smartReplies={smartReplies}
        />
      </div>
    </div>
  );
}
