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

function isOwnMessage(authorRole: string, viewerRole: ViewerRole): boolean {
  const normalizedAuthorRole = String(authorRole || '').trim().toUpperCase();
  return normalizedAuthorRole === viewerRole;
}

function getRoleLabel(authorRole: string, viewerRole: ViewerRole): string {
  const normalizedAuthorRole = String(authorRole || '').trim().toUpperCase();
  if (viewerRole === 'DOCTOR') {
    if (normalizedAuthorRole === 'DOCTOR') return 'VOUS';
    if (normalizedAuthorRole === 'PATIENT') return 'PATIENT';
    return 'INTERLOCUTEUR';
  }

  if (normalizedAuthorRole === 'PATIENT') return 'VOUS';
  if (normalizedAuthorRole === 'DOCTOR') return 'MÉDECIN';
  return 'INTERLOCUTEUR';
}

const MessageList = React.memo(
  function MessageListComponent({ messages, viewerRole, fileIndex, onDownloadFile }: Props) {
    return (
      <div className="sp-thread-list">
        {messages.map((message) => {
          const mine = isOwnMessage(message.author_role, viewerRole);
          const roleLabel = getRoleLabel(message.author_role, viewerRole);
          const attachmentIds = Array.isArray(message.attachments) ? message.attachments : [];

          return (
            <div key={message.id} className={cx('sp-thread-item', mine && 'is-own')}>
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

                <div className="sp-thread-item__meta">{message.created_at}</div>
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
