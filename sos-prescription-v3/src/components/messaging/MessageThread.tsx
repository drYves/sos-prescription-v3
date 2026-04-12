import React, { useEffect, useMemo, useRef, useState } from 'react';
import MessageList from './MessageList';

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

type SmartReplyOption = {
  type?: string;
  title?: string;
  body: string;
};

type PolishResult = {
  rewritten_body?: string;
  changes_summary?: string[];
  risk_flags?: string[];
};

type Props = {
  prescriptionId: number | null;
  viewerRole: ViewerRole;
  currentUserRoles?: string[] | string;
  title: string;
  subtitle: string;
  loading?: boolean;
  emptyText: string;
  messages: MessageItem[];
  fileIndex: Record<number, UploadedFile>;
  onDownloadFile: (attachmentId: number) => void | Promise<void>;
  canCompose: boolean;
  readOnlyNotice?: string;
  postMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  onMessageCreated: (message: MessageItem) => void | Promise<void>;
  onSurfaceError?: (message: string | null) => void;
  enablePolish?: boolean;
  onPolishDraft?: (draft: string) => Promise<PolishResult>;
  smartReplies?: SmartReplyOption[];
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
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

function composerPlaceholder(viewerRole: ViewerRole): string {
  return viewerRole === 'DOCTOR' ? 'Écrire au patient...' : 'Écrire au médecin...';
}

function BotAssistIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M7.5 8.5h9A3.5 3.5 0 0 1 20 12v4a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16v-4a3.5 3.5 0 0 1 3.5-3.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9.5 13h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M14.5 13h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M9 16.5c.9.6 1.9.9 3 .9s2.1-.3 3-.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function MessageThread({
  prescriptionId,
  viewerRole,
  currentUserRoles,
  title,
  subtitle,
  loading = false,
  emptyText,
  messages,
  fileIndex,
  onDownloadFile,
  canCompose,
  readOnlyNotice = 'La messagerie est en lecture seule pour ce dossier.',
  postMessage,
  onMessageCreated,
  onSurfaceError,
  enablePolish = false,
  onPolishDraft,
  smartReplies = [],
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [sending, setSending] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraftBody('');
    setSending(false);
    setPolishing(false);
    setLocalError(null);
  }, [prescriptionId]);

  const visibleReplies = useMemo(() => smartReplies.slice(0, 3).filter((item) => String(item.body || '').trim() !== ''), [smartReplies]);

  const handleSend = async (): Promise<void> => {
    const body = draftBody.trim();
    if (!prescriptionId || !body || sending) {
      return;
    }

    setLocalError(null);
    onSurfaceError?.(null);
    setSending(true);

    try {
      const message = await postMessage(prescriptionId, body);
      await Promise.resolve(onMessageCreated(message));
      setDraftBody('');
      textareaRef.current?.focus();
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'Erreur envoi';
      setLocalError(nextError);
      onSurfaceError?.(nextError);
    } finally {
      setSending(false);
    }
  };

  const handlePolish = async (): Promise<void> => {
    const sourceDraft = draftBody.trim();
    if (!enablePolish || !onPolishDraft || polishing || sending || sourceDraft === '') {
      return;
    }

    setLocalError(null);
    onSurfaceError?.(null);
    setPolishing(true);

    try {
      const result = await Promise.resolve(onPolishDraft(sourceDraft));
      const rewritten = typeof result?.rewritten_body === 'string' && result.rewritten_body.trim() !== ''
        ? result.rewritten_body
        : sourceDraft;
      setDraftBody(rewritten);
      textareaRef.current?.focus();
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'Impossible de reformuler le message.';
      setLocalError(nextError);
      onSurfaceError?.(nextError);
    } finally {
      setPolishing(false);
    }
  };

  const applySmartReply = (body: string): void => {
    const nextValue = String(body || '').trim();
    if (!nextValue) {
      return;
    }
    setDraftBody(nextValue);
    setLocalError(null);
    onSurfaceError?.(null);
    textareaRef.current?.focus();
  };

  return (
    <div className="sp-stack">
      <div className="sp-page-heading">
        <div className="sp-page-title sp-page-title--section">{title}</div>
        <div className="sp-page-subtitle">{subtitle}</div>
      </div>

      {loading && messages.length === 0 ? (
        <div className="sp-loading-row">
          <InlineSpinner />
          <span>Chargement…</span>
        </div>
      ) : messages.length === 0 ? (
        <div className="sp-empty-note">{emptyText}</div>
      ) : (
        <MessageList
          messages={messages}
          viewerRole={viewerRole}
          currentUserRoles={currentUserRoles}
          fileIndex={fileIndex}
          onDownloadFile={onDownloadFile}
        />
      )}

      {canCompose ? (
        <div className="sp-card sp-thread-composer sp-thread-composer--text-only">
          {localError ? <Notice variant="error">{localError}</Notice> : null}

          <div className="sp-thread-composer__row">
            <div className="sp-thread-composer__field">
              <textarea
                ref={textareaRef}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={2}
                placeholder={composerPlaceholder(viewerRole)}
                className="sp-textarea sp-thread-composer__textarea"
              />
            </div>

            <div className="sp-thread-composer__actions">
              {enablePolish && onPolishDraft ? (
                <button
                  type="button"
                  className="sp-app-icon-button"
                  onClick={() => void handlePolish()}
                  disabled={polishing || sending || draftBody.trim().length < 1}
                  title="Aide à la rédaction"
                  aria-label="Aide à la rédaction"
                >
                  {polishing ? <InlineSpinner /> : <BotAssistIcon />}
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || draftBody.trim().length < 1}
                className={cx('sp-button', 'sp-button--primary', sending && 'is-loading')}
              >
                {sending ? <InlineSpinner /> : 'Envoyer'}
              </button>
            </div>
          </div>

          {viewerRole === 'DOCTOR' && visibleReplies.length > 0 ? (
            <>
              <div className="sp-thread-composer__hint">Suggestions de réponse</div>
              <div className="sp-inline-actions">
                {visibleReplies.map((reply, index) => {
                  const label = String(reply.title || reply.body || '').trim() || `Suggestion ${index + 1}`;
                  return (
                    <button
                      key={`${reply.type || 'reply'}-${index}`}
                      type="button"
                      className="sp-button sp-button--secondary"
                      onClick={() => applySmartReply(reply.body)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <Notice variant="info">{readOnlyNotice}</Notice>
      )}
    </div>
  );
}
