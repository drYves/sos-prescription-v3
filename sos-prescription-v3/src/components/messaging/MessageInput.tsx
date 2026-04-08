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

function InlineSpinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-transparent" aria-label="Chargement" />;
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
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-semibold text-gray-900">{inputCopy.title}</div>

      {localError ? (
        <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          {localError}
        </div>
      ) : null}

      <div className="mt-3 flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(event) => {
            void handleUploadFiles(event.target.files);
            event.currentTarget.value = '';
          }}
        />

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-300 bg-white text-gray-600 transition hover:bg-gray-50 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Ajouter un document"
          title="Ajouter un document"
          disabled={uploading || sending}
        >
          <span aria-hidden="true">📎</span>
        </button>

        <div className="flex-1">
          <textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            rows={2}
            placeholder={inputCopy.placeholder}
            className="w-full rounded-2xl border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || uploading || draftBody.trim().length < 1}
          className="inline-flex items-center justify-center rounded-2xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? <InlineSpinner /> : 'Envoyer'}
        </button>
      </div>

      {uploading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
          <InlineSpinner />
          <span>Upload en cours…</span>
        </div>
      ) : null}

      {queuedUploads.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {queuedUploads.map((file) => (
            <span
              key={file.id}
              className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-700"
            >
              <span className="max-w-[220px] truncate">{file.original_name}</span>
              <button
                type="button"
                className="text-gray-500 transition hover:text-gray-700"
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
