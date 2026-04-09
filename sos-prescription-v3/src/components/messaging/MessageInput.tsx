import React, { useEffect, useMemo, useState } from 'react';

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
  prescriptionId: number | null;
  viewerRole: ViewerRole;
  uploadFile?: (file: File, purpose: string, prescriptionId?: number) => Promise<UploadedFile>;
  postMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  onUploadsRegistered?: (files: UploadedFile[]) => void;
  onMessageCreated: (message: MessageItem) => void | Promise<void>;
  onSurfaceError?: (message: string | null) => void;
  allowAttachments?: boolean;
};

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function InlineSpinner() {
  return <span className="sp-spinner" aria-label="Chargement" />;
}

function fieldCopy(viewerRole: ViewerRole): { title: string; placeholder: string } {
  if (viewerRole === 'DOCTOR') {
    return {
      title: 'Envoyer un message',
      placeholder: 'Votre message au patient…',
    };
  }

  return {
    title: 'Envoyer un message',
    placeholder: 'Votre message au médecin…',
  };
}

const MessageInput = React.memo(function MessageInputComponent({
  prescriptionId,
  viewerRole,
  postMessage,
  onMessageCreated,
  onSurfaceError,
}: Props) {
  const inputCopy = useMemo(() => fieldCopy(viewerRole), [viewerRole]);

  const [draftBody, setDraftBody] = useState('');
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraftBody('');
    setSending(false);
    setLocalError(null);
  }, [prescriptionId]);

  const handleSend = async (): Promise<void> => {
    const body = draftBody.trim();
    if (!prescriptionId || !body || sending) return;

    setLocalError(null);
    onSurfaceError?.(null);
    setSending(true);

    try {
      const message = await postMessage(prescriptionId, body);
      await Promise.resolve(onMessageCreated(message));
      setDraftBody('');
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'Erreur envoi';
      setLocalError(nextError);
      onSurfaceError?.(nextError);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sp-card sp-thread-composer sp-thread-composer--text-only">
      <div className="sp-thread-composer__title">{inputCopy.title}</div>

      {localError ? (
        <div className="sp-alert sp-alert--error">
          <div className="sp-alert__body">{localError}</div>
        </div>
      ) : null}

      <div className="sp-thread-composer__row">
        <div className="sp-thread-composer__field">
          <textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            rows={2}
            placeholder={inputCopy.placeholder}
            className="sp-textarea sp-thread-composer__textarea"
          />
        </div>

        <div className="sp-thread-composer__actions">
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

      <div className="sp-thread-composer__hint">
        Les échanges sont textuels uniquement pour cette demande.
      </div>
    </div>
  );
});

export default MessageInput;
