import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MessageInput from './messaging/MessageInput';
import MessageList from './messaging/MessageList';

type AppConfig = {
  restBase: string;
  nonce: string;
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
};

type ArtifactAccessPayload = {
  access?: {
    url?: string;
  };
};

type DoctorMessagingWindow = Window & {
  SOSPrescription?: AppConfig;
  SosPrescription?: AppConfig;
};

const POLL_VISIBLE_MS = 15000;
const POLL_HIDDEN_MS = 30000;

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

async function apiJson<T>(path: string, init: RequestInit, scope = 'admin'): Promise<T> {
  const cfg = getAppConfig();
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('X-WP-Nonce', cfg.nonce);
  headers.set('Accept', 'application/json');
  headers.set('X-Sos-Scope', scope);

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

function normalizeMode(value: unknown): 'DOCTOR_ONLY' | 'PATIENT_REPLY' | 'READ_ONLY' | '' {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'DOCTOR_ONLY' || normalized === 'PATIENT_REPLY' || normalized === 'READ_ONLY') {
    return normalized;
  }
  return '';
}

function normalizeMessage(input: Partial<MessageItem> | null | undefined): MessageItem {
  const fallbackAttachments = Array.isArray((input as { attachment_artifact_ids?: unknown } | null)?.attachment_artifact_ids)
    ? ((input as { attachment_artifact_ids: unknown[] }).attachment_artifact_ids as unknown[])
    : [];
  const attachmentsSource = Array.isArray(input?.attachments) ? input.attachments : fallbackAttachments;

  return {
    id: Number(input?.id || input?.seq || Date.now()),
    seq: Number(input?.seq || 0) || undefined,
    author_role: String(input?.author_role || 'DOCTOR'),
    body: String(input?.body || ''),
    created_at: String(input?.created_at || ''),
    attachments: attachmentsSource
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0),
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

async function getDoctorMessages(prescriptionId: number): Promise<ThreadPayload> {
  return apiJson<ThreadPayload>(`/prescriptions/${prescriptionId}/messages`, { method: 'GET' }, 'admin');
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

async function uploadDoctorFile(file: File, purpose: string, prescriptionId?: number): Promise<UploadedFile> {
  const formData = new FormData();
  formData.append('purpose', purpose);
  if (prescriptionId && prescriptionId > 0) {
    formData.append('prescription_id', String(prescriptionId));
  }
  formData.append('file', file);

  return apiJson<UploadedFile>('/files', { method: 'POST', body: formData }, 'admin');
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
    return 'Vous pouvez initier l’échange sécurisé avec le patient depuis cet espace.';
  }
  return '';
}

export default function DoctorMessagingApp({ prescriptionId }: { prescriptionId: number }) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [threadState, setThreadState] = useState<ThreadState>({});
  const [files, setFiles] = useState<Record<number, UploadedFile>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [hidden, setHidden] = useState<boolean>(typeof document !== 'undefined' ? document.hidden : false);

  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const markReadSeqRef = useRef(0);

  const viewerRole: ViewerRole = 'DOCTOR';
  const mode = normalizeMode(threadState.mode);
  const modeNotice = useMemo(() => threadModeNotice(mode), [mode]);

  const fileIndex = useMemo(() => files, [files]);

  const registerUploadedFiles = useCallback((uploadedFiles: UploadedFile[]) => {
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return;
    }

    setFiles((current) => {
      const next = { ...current };
      uploadedFiles.forEach((file) => {
        next[file.id] = file;
      });
      return next;
    });
  }, []);

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
        setThreadState(payload.thread_state);
      }
    } catch {
      markReadSeqRef.current = 0;
    }
  }, [prescriptionId]);

  const loadThread = useCallback(async (silent = false): Promise<void> => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    if (!silent) {
      setLoading(true);
    }

    try {
      const payload = await getDoctorMessages(prescriptionId);
      if (!mountedRef.current || requestRef.current !== requestId) {
        return;
      }

      const nextMessages = dedupeMessages(Array.isArray(payload?.messages) ? payload.messages : []);
      const nextThreadState = payload && payload.thread_state ? payload.thread_state : {};

      setMessages(nextMessages);
      setThreadState(nextThreadState);
      setError(null);

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
  }, [markReadIfNeeded, prescriptionId]);

  useEffect(() => {
    mountedRef.current = true;
    requestRef.current = 0;
    markReadSeqRef.current = 0;
    setMessages([]);
    setThreadState({});
    setFiles({});
    setError(null);
    setFlash(null);
    setLoading(false);

    void loadThread(false);

    return () => {
      mountedRef.current = false;
    };
  }, [loadThread, prescriptionId]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      setHidden(document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadThread(true);
    }, hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [hidden, loadThread]);

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
    await loadThread(true);
  }, [loadThread]);

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
    <div className="sp-thread-shell dc-message-react-panel">
      <div className="sp-thread-shell__header">
        <div>
          <div className="sp-thread-shell__title">Messagerie patient</div>
          <div className="sp-thread-shell__subtitle">Échange sécurisé associé à ce dossier.</div>
        </div>

        <button
          type="button"
          className="sp-button sp-button--secondary"
          onClick={() => void loadThread(false)}
          disabled={loading}
        >
          {loading ? <InlineSpinner /> : 'Actualiser'}
        </button>
      </div>

      {flash ? <Notice variant="success">{flash}</Notice> : null}
      {error ? <Notice variant="error">{error}</Notice> : null}
      {modeNotice ? <Notice variant="info">{modeNotice}</Notice> : null}

      {loading && messages.length === 0 ? (
        <div className="sp-loading-row">
          <InlineSpinner />
          <span>Chargement de la messagerie…</span>
        </div>
      ) : messages.length === 0 ? (
        <div className="sp-empty-note">Aucun message pour le moment.</div>
      ) : (
        <MessageList
          messages={messages}
          viewerRole={viewerRole}
          fileIndex={fileIndex}
          onDownloadFile={handleAttachmentDownload}
        />
      )}

      {mode !== 'READ_ONLY' ? (
        <MessageInput
          prescriptionId={prescriptionId}
          viewerRole={viewerRole}
          uploadFile={uploadDoctorFile}
          postMessage={postDoctorMessage}
          onUploadsRegistered={registerUploadedFiles}
          onMessageCreated={handleMessageCreated}
          onSurfaceError={setError}
          allowAttachments={false}
        />
      ) : null}
    </div>
  );
}
