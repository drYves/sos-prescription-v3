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
  author_role: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

type Props = {
  messages: MessageItem[];
  viewerRole: ViewerRole;
  fileIndex: Record<number, UploadedFile>;
  onDownloadFile: (attachmentId: number) => void | Promise<void>;
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function normalizeRole(authorRole: string): string {
  return String(authorRole || '').trim().toUpperCase();
}

function isOwnMessage(authorRole: string, viewerRole: ViewerRole): boolean {
  return normalizeRole(authorRole) === viewerRole;
}

function getRoleLabel(authorRole: string, viewerRole: ViewerRole): string {
  const normalizedAuthorRole = normalizeRole(authorRole);

  if (viewerRole === 'DOCTOR') {
    if (normalizedAuthorRole === 'DOCTOR') return 'VOUS';
    if (normalizedAuthorRole === 'PATIENT') return 'PATIENT';
    return 'INTERLOCUTEUR';
  }

  if (normalizedAuthorRole === 'PATIENT') return 'MOI';
  if (normalizedAuthorRole === 'DOCTOR') return 'MÉDECIN';
  return 'INTERLOCUTEUR';
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
  function MessageListComponent({ messages, viewerRole, fileIndex, onDownloadFile }: Props) {
    return (
      <div className={cx('sp-thread-list', `sp-thread-list--viewer-${viewerRole.toLowerCase()}`)}>
        {messages.map((message, index) => {
          const mine = isOwnMessage(message.author_role, viewerRole);
          const roleLabel = getRoleLabel(message.author_role, viewerRole);
          const attachmentIds = Array.isArray(message.attachments) ? message.attachments : [];
          const normalizedRole = normalizeRole(message.author_role);
          const formattedDate = formatMessageDate(message.created_at);
          const itemKey = Number.isFinite(Number(message.id)) && Number(message.id) > 0
            ? String(message.id)
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
                viewerRole === 'PATIENT' && 'sp-thread-item--viewer-patient',
                viewerRole === 'DOCTOR' && 'sp-thread-item--viewer-doctor',
              )}
            >
              <article className="sp-thread-item__bubble">
                <div className="sp-thread-item__author">{roleLabel}</div>

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
                          <span className="sp-button__icon" aria-hidden="true">📎</span>
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
    && prevProps.fileIndex === nextProps.fileIndex
    && prevProps.onDownloadFile === nextProps.onDownloadFile,
);

export default MessageList;
