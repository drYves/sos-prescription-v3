import React, { useRef } from 'react';
import type { LocalUpload } from '../formTunnel/types';

type IntakeSectionProps = {
  isLoggedIn: boolean;
  files: LocalUpload[];
  rejectedFiles: File[];
  analysisInProgress: boolean;
  analysisMessage: string | null;
  onFilesSelected: (list: FileList | null) => void;
  onRemoveFile: (fileId: string) => void;
};

export function IntakeSection({
  isLoggedIn,
  files,
  rejectedFiles,
  analysisInProgress,
  analysisMessage,
  onFilesSelected,
  onRemoveFile,
}: IntakeSectionProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="sp-app-card">
      <div className="sp-app-section__header">
        <div>
          <h2 className="sp-app-section__title">Justificatifs médicaux</h2>
          <p className="sp-app-section__hint">
            Importez votre ordonnance ou une photo de la boîte. Cela nous aide à vérifier le traitement et à pré-remplir la demande.
          </p>
        </div>
      </div>

      <div className="sp-app-upload">
        <input
          id="sp-evidence-input"
          ref={inputRef}
          type="file"
          className="sp-app-hidden"
          accept="image/jpeg,image/png,application/pdf"
          multiple
          disabled={analysisInProgress}
          onChange={(event) => {
            onFilesSelected(event.target.files);
            event.currentTarget.value = '';
          }}
        />

        <div className="sp-app-upload__actions">
          <button
            type="button"
            className="sp-app-button sp-app-button--secondary"
            disabled={analysisInProgress}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            Ajouter un document
          </button>

          {analysisInProgress ? (
            <div className="sp-app-inline-status">
              <span className="sp-app-spinner" aria-label="Chargement" />
              <span>Lecture du document en cours...</span>
            </div>
          ) : null}
        </div>

        <div className="sp-app-field__hint">JPG, PNG ou PDF (Max 5 Mo)</div>
        {!isLoggedIn ? (
          <div className="sp-app-field__hint sp-app-field__hint--warning">
            Vous pourrez valider votre adresse à la fin du parcours. Les documents seront liés à votre dossier avant le paiement.
          </div>
        ) : null}
      </div>

      {files.length > 0 ? (
        <div className="sp-app-upload-list">
          {files.map((file) => (
            <div key={file.id} className="sp-app-upload-item">
              <div className="sp-app-upload-item__content">
                <div className="sp-app-upload-item__title">{file.original_name}</div>
                <div className="sp-app-upload-item__meta">
                  {Math.round((file.size_bytes || 0) / 1024)} Ko • {file.mime || 'application/octet-stream'}
                </div>
              </div>
              <button
                type="button"
                className="sp-app-button sp-app-button--secondary sp-app-button--compact sp-app-button--copy"
                onClick={() => onRemoveFile(file.id)}
                aria-label={`Retirer ${file.original_name}`}
                title="Retirer"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {analysisMessage ? (
        <div className="sp-app-block">
          <div className="sp-app-notice sp-app-notice--success">{analysisMessage}</div>
        </div>
      ) : null}

      {rejectedFiles.length > 0 ? (
        <div className="sp-app-block">
          <div className="sp-app-notice sp-app-notice--warning">
            <div className="sp-app-notice__title">Documents à vérifier</div>
            <div className="sp-app-notice__text">
              Certains documents n’ont pas pu être lus.
            </div>
            <div className="sp-app-tag-list">
              {rejectedFiles.map((file, index) => (
                <span key={`${file.name}-${index}`} className="sp-app-tag">{file.name}</span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
