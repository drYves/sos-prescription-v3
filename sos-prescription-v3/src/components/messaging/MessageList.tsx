import React from 'react';

type ViewerRole = 'PATIENT' | 'DOCTOR';

type MessageItem = {
  id: number;
  author_role: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

type PrescriptionFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url: string;
};

type Props = {
  messages: MessageItem[];
  viewerRole: ViewerRole;
  fileIndex: Record<number, PrescriptionFile>;
  onDownloadFile: (attachmentId: number) => void | Promise<void>;
};

function normalizeRole(role: string): 'PATIENT' | 'DOCTOR' | 'UNKNOWN' {
  const normalized = String(role || '').trim().toUpperCase();
  if (normalized === 'PATIENT') return 'PATIENT';
  if (normalized === 'DOCTOR') return 'DOCTOR';
  return 'UNKNOWN';
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

  if (normalizedAuthorRole === 'PATIENT') return 'VOUS';
  if (normalizedAuthorRole === 'DOCTOR') return 'MÉDECIN';
  return 'INTERLOCUTEUR';
}

const MessageList = React.memo(
  function MessageListComponent({ messages, viewerRole, fileIndex, onDownloadFile }: Props) {
    return (
      <div className="space-y-3">
        {messages.map((message) => {
          const mine = isOwnMessage(message.author_role, viewerRole);
          const roleLabel = getRoleLabel(message.author_role, viewerRole);
          const attachmentIds = Array.isArray(message.attachments) ? message.attachments : [];

          return (
            <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <article
                className={`max-w-[88%] rounded-2xl border px-4 py-3 shadow-sm ${
                  mine
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-gray-50 text-gray-900'
                }`}
              >
                <div className={`mb-2 text-[11px] font-semibold tracking-[0.08em] ${mine ? 'text-gray-300' : 'text-gray-500'}`}>
                  {roleLabel}
                </div>

                <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.body}</div>

                {attachmentIds.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {attachmentIds.map((attachmentId) => {
                      const file = fileIndex[attachmentId];
                      const filename = file ? file.original_name : `Fichier #${attachmentId}`;

                      return (
                        <button
                          key={attachmentId}
                          type="button"
                          className={`block w-full rounded-2xl border px-3 py-2 text-left text-xs transition ${
                            mine
                              ? 'border-gray-700 bg-gray-800 text-white hover:border-gray-500 hover:bg-gray-700'
                              : 'border-gray-200 bg-white text-gray-900 hover:border-gray-300 hover:bg-gray-100'
                          }`}
                          onClick={() => void onDownloadFile(attachmentId)}
                        >
                          📎 {filename}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className={`mt-3 text-[11px] ${mine ? 'text-gray-300' : 'text-gray-500'}`}>{message.created_at}</div>
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
