import React, { useEffect, useMemo, useRef, useState } from 'react';

type ViewerRole = 'PATIENT' | 'DOCTOR';

type UploadedFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url: string;
};

type MessageItem = {
  id: number;
  author_role: string;
  body: string;
  created_at: string;
  attachments?: number[];
};

type Props = {
  prescriptionId: number;
  viewerRole: ViewerRole;
  uploadFile: (file: File, purpose: string, prescriptionId?: number) => Promise<UploadedFile>;
  postMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  onUploadsRegistered: (files: UploadedFile[]) => void;
  onMessageCreated: (message: MessageItem) => void | Promise<void>;
  onSurfaceError?: (message: string | null) => void;
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
  uploadFile,
  postMessage,
  onUploadsRegistered,
  onMessageCreated,
  onSurfaceError,
}: Props) {
  const inputCopy = useMemo(() => fieldCopy(viewerRole), [viewerRole]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [draftBody, setDraftBody] = useState('');
  const [queuedUploads, setQueuedUploads] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setDraftBody('');
    setQueuedUploads([]);
    setUploading(false);
    setSending(false);
    setLocalError(null);
  }, [prescriptionId]);

  const handleUploadFiles = async (fileList: FileList | null): Promise<void> => {
    if (!fileList || fileList.length === 0 || !prescriptionId) return;

    setLocalError(null);
    onSurfaceError?.(null);
    setUploading(true);

    try {
      const uploaded: UploadedFile[] = [];
      for (const file of Array.from(fileList)) {
        const payload = await uploadFile(file, 'message', prescriptionId);
        uploaded.push(payload);
      }

      if (uploaded.length > 0) {
        onUploadsRegistered(uploaded);
        setQueuedUploads((current) => [...current, ...uploaded]);
      }
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'Erreur upload';
      setLocalError(nextError);
      onSurfaceError?.(nextError);
    } finally {
      setUploading(false);
    }
  };

  const handleSend = async (): Promise<void> => {
    const body = draftBody.trim();
    if (!prescriptionId || !body || sending || uploading) return;

    setLocalError(null);
    onSurfaceError?.(null);
    setSending(true);

    try {
      const attachmentIds = queuedUploads.map((file) => file.id);
      const message = await postMessage(
        prescriptionId,
        body,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      );

      await Promise.resolve(onMessageCreated(message));
      setDraftBody('');
      setQueuedUploads([]);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : 'Erreur envoi';
      setLocalError(nextError);
      onSurfaceError?.(nextError);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sp-card sp-thread-composer">
      <div className="sp-thread-composer__title">{inputCopy.title}</div>

      {localError ? (
        <div className="sp-alert sp-alert--error">
          <div className="sp-alert__body">{localError}</div>
        </div>
      ) : null}

      <div className="sp-thread-composer__row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="sp-hidden"
          onChange={(event) => {
            void handleUploadFiles(event.target.files);
            event.currentTarget.value = '';
          }}
        />

        <button
          type="button"
          className="sp-button sp-button--secondary sp-button--icon"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Ajouter un document"
          title="Ajouter un document"
          disabled={uploading || sending}
        >
          <span className="sp-button__icon" aria-hidden="true">📎</span>
        </button>

        <div className="sp-thread-composer__field">
          <textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            rows={2}
            placeholder={inputCopy.placeholder}
            className="sp-textarea sp-thread-composer__textarea"
          />
        </div>

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || uploading || draftBody.trim().length < 1}
          className={cx('sp-button', 'sp-button--primary', sending && 'is-loading')}
        >
          {sending ? <InlineSpinner /> : 'Envoyer'}
        </button>
      </div>

      {uploading ? (
        <div className="sp-thread-composer__status sp-loading-row">
          <InlineSpinner />
          <span>Upload en cours…</span>
        </div>
      ) : null}

      {queuedUploads.length > 0 ? (
        <div className="sp-thread-queued">
          {queuedUploads.map((file) => (
            <span key={file.id} className="sp-thread-queued__item">
              <span className="sp-thread-queued__name">{file.original_name}</span>
              <button
                type="button"
                className="sp-thread-queued__remove"
                onClick={() => setQueuedUploads((current) => current.filter((item) => item.id !== file.id))}
                aria-label={`Retirer ${file.original_name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export default MessageInput;
