import React from 'react';

type ViewerRole = 'PATIENT' | 'DOCTOR';

type UploadedFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url?: string;
};

type MessageItem = {
  id: number;
  seq?: number;
  author_role: string;
  author_wp_user_id?: number;
  author_name?: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

type Props = {
  messages: MessageItem[];
  viewerRole: ViewerRole;
  currentUserRoles?: string[] | string;
  fileIndex: Record<number, UploadedFile>;
  onDownloadFile: (attachmentId: number) => void | Promise<void>;
};

type MessageListWindow = Window & {
  SOSPrescription?: {
    currentUser?: {
      id?: number | string;
    };
  };
  SosPrescription?: {
    currentUser?: {
      id?: number | string;
    };
  };
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function normalizeRole(authorRole: string): string {
  const normalized = String(authorRole || '').trim().toLowerCase();
  if (normalized === '') {
    return '';
  }

  if (normalized.includes('patient')) {
    return 'PATIENT';
  }

  if (
    normalized.includes('doctor')
    || normalized.includes('medecin')
    || normalized.includes('médecin')
    || normalized.includes('physician')
    || normalized.includes('praticien')
    || normalized.includes('admin')
    || normalized.includes('administrator')
  ) {
    return 'DOCTOR';
  }

  return normalized.toUpperCase();
}

function normalizeWpUserId(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

function getCurrentWpUserId(): number {
  const g = window as MessageListWindow;
  const cfg = g.SosPrescription || g.SOSPrescription;
  return normalizeWpUserId(cfg?.currentUser?.id);
}

function isOwnMessage(message: MessageItem): boolean {
  const currentUserId = getCurrentWpUserId();
  if (currentUserId < 1) {
    return false;
  }

  return normalizeWpUserId(message.author_wp_user_id) === currentUserId;
}

function formatDoctorLabel(authorName: string | undefined): string {
  const normalized = String(authorName || '').trim().replace(/\s+/g, ' ');
  if (normalized === '') {
    return 'Le médecin';
  }

  const withoutPrefix = normalized
    .replace(/^(dr|docteur|doctor)\.?\s+/i, '')
    .trim();

  if (withoutPrefix === '') {
    return 'Le médecin';
  }

  return `Dr. ${withoutPrefix}`;
}

function getRoleLabel(message: MessageItem): string {
  const normalizedAuthorRole = normalizeRole(message.author_role);

  if (isOwnMessage(message)) {
    return 'Vous';
  }

  if (normalizedAuthorRole === 'PATIENT') return 'Patient';
  if (normalizedAuthorRole === 'DOCTOR') return formatDoctorLabel(message.author_name);
  return 'Interlocuteur';
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="sp-lucide">
      <path d="m21.44 11.05-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l9.2-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.19 9.2a1.5 1.5 0 1 1-2.13-2.13l8.49-8.49" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatMessageDate(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return raw;
  }

  try {
    const formatter = new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const parts = formatter.formatToParts(date);
    const map: Record<string, string> = {};

    parts.forEach((part) => {
      if (part.type !== 'literal') {
        map[part.type] = part.value;
      }
    });

    const day = map.day || '';
    const month = map.month || '';
    const year = map.year || '';
    const hour = map.hour || '';
    const minute = map.minute || '';

    if (day && month && year && hour && minute) {
      return `${day} ${month} ${year} à ${hour}:${minute}`;
    }

    return formatter.format(date);
  } catch {
    return raw;
  }
}

const MessageList = React.memo(
  function MessageListComponent({ messages, viewerRole, currentUserRoles: _currentUserRoles, fileIndex, onDownloadFile }: Props) {
    return (
      <div className="sp-thread-list" data-viewer-role={viewerRole.toLowerCase()}>
        {messages.map((message, index) => {
          const mine = isOwnMessage(message);
          const roleLabel = getRoleLabel(message);
          const attachmentIds = Array.isArray(message.attachments) ? message.attachments : [];
          const normalizedRole = normalizeRole(message.author_role);
          const formattedDate = formatMessageDate(message.created_at);
          const messageSeq = Number((message as { seq?: unknown }).seq || 0);
          const itemKey = Number.isFinite(messageSeq) && messageSeq > 0
            ? `seq:${messageSeq}`
            : Number.isFinite(Number(message.id)) && Number(message.id) > 0
            ? `id:${message.id}`
            : `${normalizedRole}-${message.created_at}-${index}`;

          return (
            <div
              key={itemKey}
              className={cx(
                'sp-thread-item',
                mine && 'is-own',
                mine && 'sp-thread-item--mine',
                normalizedRole === 'DOCTOR' && 'sp-thread-item--role-doctor',
                normalizedRole === 'PATIENT' && 'sp-thread-item--role-patient',
              )}
              data-viewer-role={viewerRole.toLowerCase()}
              data-author-role={normalizedRole.toLowerCase()}
            >
              <article className="sp-thread-item__bubble">
                <div
                  className={cx(
                    'sp-thread-item__author',
                    normalizedRole === 'DOCTOR' && 'sp-thread-item__author--doctor',
                  )}
                >
                  {roleLabel}
                </div>

                <div className="sp-thread-item__body">{message.body}</div>

                {attachmentIds.length > 0 ? (
                  <div className="sp-thread-item__attachments">
                    {attachmentIds.map((attachmentId) => {
                      const file = fileIndex[attachmentId];
                      const filename = file ? file.original_name : `Fichier #${attachmentId}`;

                      return (
                        <button
                          key={attachmentId}
                          type="button"
                          className="sp-button sp-button--secondary sp-thread-item__attachment"
                          onClick={() => void onDownloadFile(attachmentId)}
                        >
                          <span className="sp-button__icon" aria-hidden="true"><PaperclipIcon /></span>
                          <span>{filename}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className="sp-thread-item__meta">{formattedDate || message.created_at}</div>
              </article>
            </div>
          );
        })}
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.messages === nextProps.messages
    && prevProps.viewerRole === nextProps.viewerRole
    && prevProps.currentUserRoles === nextProps.currentUserRoles
    && prevProps.fileIndex === nextProps.fileIndex
    && prevProps.onDownloadFile === nextProps.onDownloadFile,
);

export default MessageList;
