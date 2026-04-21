import React from 'react';
import MessageThread from '../messaging/MessageThread';

type PaymentShadow = {
  local_status?: string | null;
  provider?: string | null;
  status?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  priority?: string | null;
  flow?: string | null;
  reference?: string | null;
  transaction_at?: string | null;
};

type PdfState = {
  status?: string;
  can_download?: boolean;
  download_url?: string;
  expires_in?: number;
  message?: string;
  last_error_code?: string | null;
  last_error_message?: string | null;
};

type RequestDetailField = {
  label: string;
  value: string;
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

type UploadedFile = {
  id: number;
  original_name: string;
  purpose?: string;
  mime?: string;
  size_bytes?: number;
  download_url?: string;
};

type PrescriptionFileRow = {
  id: number;
  originalName: string;
  meta: string;
  downloadUrl: string;
};

type PrescriptionItemRow = {
  key: string;
  denomination: string;
  posologie?: string;
  quantite?: string;
};

type HeroBannerProps = {
  title: string;
  status: string;
  createdAt: string;
  pdf: PdfState | null;
  decisionReason?: string;
};

type PdfCardProps = {
  status: string;
  pdf: PdfState | null;
  downloadBusy?: boolean;
  onDownload: () => void | Promise<void>;
};

type PatientPaymentSectionProps = {
  prescriptionId: number;
  priority: 'express' | 'standard';
  billingName?: string;
  billingEmail?: string;
  amountCents?: number | null;
  currency?: string | null;
  etaValue?: string | null;
  onPaid: () => void;
};

type PaymentDetailsCardProps = {
  status: string;
  payment: PaymentShadow | undefined;
  fallbackPriority?: string | null;
  fallbackUid?: string | null;
};

type RequestDetailsDisclosureProps = {
  fields: RequestDetailField[];
};

type ButtonLikeProps = {
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  children?: React.ReactNode;
};

type SpinnerLikeProps = {
  className?: string;
};

type RequestDetailPanelProps = {
  selectedId: number | null;
  detailLoading: boolean;
  hasDetail: boolean;
  HeroBannerComponent: React.ComponentType<HeroBannerProps>;
  PdfCardComponent: React.ComponentType<PdfCardProps>;
  PatientPaymentSectionComponent: React.ComponentType<PatientPaymentSectionProps>;
  PaymentDetailsCardComponent: React.ComponentType<PaymentDetailsCardProps>;
  RequestDetailsDisclosureComponent: React.ComponentType<RequestDetailsDisclosureProps>;
  ButtonComponent: React.ComponentType<ButtonLikeProps>;
  SpinnerComponent: React.ComponentType<SpinnerLikeProps>;
  requestTitle: string;
  selectedStatus: string;
  requestCreatedAt: string;
  selectedPdf: PdfState | null;
  decisionReason?: string;
  pdfDownloadBusy: boolean;
  onDownloadPrescriptionPdf: () => void | Promise<void>;
  showPaymentSection: boolean;
  paymentPrescriptionId: number;
  selectedPaymentPriority: 'express' | 'standard';
  paymentFallbackPriority?: string | null;
  paymentBillingName?: string;
  paymentBillingEmail?: string;
  paymentAmountCents?: number | null;
  paymentCurrency?: string | null;
  paymentEtaValue?: string | null;
  activePayment: PaymentShadow | undefined;
  paymentFallbackUid?: string | null;
  onPaymentAuthorized: () => void;
  requestDetails: RequestDetailField[];
  documentRows: PrescriptionFileRow[];
  medicationRows: PrescriptionItemRow[];
  messagingDisclosureResetKey: string;
  messagingDisclosureDefaultOpen: boolean;
  messagingDisclosureSummary: string;
  messagingSubtitle: string;
  messagesLoading: boolean;
  messages: MessageItem[];
  fileIndex: Record<number, UploadedFile>;
  messagingLocked: boolean;
  messagingEmptyText: string;
  messagingReadOnlyNotice?: string;
  currentUserRoles?: string[] | string;
  onDownloadDetailFile: (url: string, filename: string) => void | Promise<void>;
  detailId: number;
  onDownloadMessageAttachment: (attachmentId: number) => void | Promise<void>;
  postPatientMessage: (prescriptionId: number, body: string, attachments?: number[]) => Promise<MessageItem>;
  onMessageCreated: (message: MessageItem) => void | Promise<void>;
  onThreadSurfaceError?: (message: string | null) => void;
};

export default function RequestDetailPanel({
  selectedId,
  detailLoading,
  hasDetail,
  HeroBannerComponent,
  PdfCardComponent,
  PatientPaymentSectionComponent,
  PaymentDetailsCardComponent,
  RequestDetailsDisclosureComponent,
  ButtonComponent,
  SpinnerComponent,
  requestTitle,
  selectedStatus,
  requestCreatedAt,
  selectedPdf,
  decisionReason,
  pdfDownloadBusy,
  onDownloadPrescriptionPdf,
  showPaymentSection,
  paymentPrescriptionId,
  selectedPaymentPriority,
  paymentFallbackPriority,
  paymentBillingName,
  paymentBillingEmail,
  paymentAmountCents,
  paymentCurrency,
  paymentEtaValue,
  activePayment,
  paymentFallbackUid,
  onPaymentAuthorized,
  requestDetails,
  documentRows,
  medicationRows,
  messagingDisclosureResetKey,
  messagingDisclosureDefaultOpen,
  messagingDisclosureSummary,
  messagingSubtitle,
  messagesLoading,
  messages,
  fileIndex,
  messagingLocked,
  messagingEmptyText,
  messagingReadOnlyNotice,
  currentUserRoles,
  onDownloadDetailFile,
  detailId,
  onDownloadMessageAttachment,
  postPatientMessage,
  onMessageCreated,
  onThreadSurfaceError,
}: RequestDetailPanelProps) {
  return (
    <section className="sp-console-grid__content sp-patient-console__detail">
      {!selectedId ? (
        <div className="sp-card sp-patient-console__detail-state">Sélectionnez une demande à gauche.</div>
      ) : null}

      {selectedId && detailLoading && !hasDetail ? (
        <div className="sp-card sp-patient-console__detail-state sp-patient-console__detail-state--loading">
          <div className="sp-loading-row">
            <SpinnerComponent />
            <span>Chargement…</span>
          </div>
        </div>
      ) : null}

      {selectedId && hasDetail ? (
        <div className="sp-patient-console__detail-shell">
          <div className="sp-patient-console__detail-stack">
            <HeroBannerComponent
              title={requestTitle}
              status={selectedStatus}
              createdAt={requestCreatedAt}
              pdf={selectedPdf}
              decisionReason={decisionReason}
            />

            <PdfCardComponent
              status={selectedStatus}
              pdf={selectedPdf}
              downloadBusy={pdfDownloadBusy}
              onDownload={onDownloadPrescriptionPdf}
            />

            {showPaymentSection ? (
              <div className="sp-section">
                <PatientPaymentSectionComponent
                  prescriptionId={paymentPrescriptionId}
                  priority={selectedPaymentPriority}
                  billingName={paymentBillingName}
                  billingEmail={paymentBillingEmail}
                  amountCents={paymentAmountCents ?? null}
                  currency={paymentCurrency ?? 'EUR'}
                  etaValue={paymentEtaValue ?? null}
                  onPaid={onPaymentAuthorized}
                />
              </div>
            ) : null}

            <PaymentDetailsCardComponent
              status={selectedStatus}
              payment={activePayment}
              fallbackPriority={paymentFallbackPriority ?? null}
              fallbackUid={paymentFallbackUid ?? null}
            />

            <RequestDetailsDisclosureComponent fields={requestDetails} />

            {documentRows.length > 0 ? (
              <div className="sp-section">
                <div className="sp-section__title">Documents</div>
                <div className="sp-stack sp-stack--compact">
                  {documentRows.map((file) => (
                    <div key={file.id} className="sp-inline-card">
                      <div className="sp-inline-card__row">
                        <div className="sp-inline-card__content">
                          <div className="sp-inline-card__title sp-truncate">{file.originalName}</div>
                          <div className="sp-inline-card__meta">{file.meta}</div>
                        </div>
                        <ButtonComponent
                          type="button"
                          variant="secondary"
                          onClick={() => void onDownloadDetailFile(file.downloadUrl, file.originalName)}
                        >
                          Télécharger
                        </ButtonComponent>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {medicationRows.length > 0 ? (
              <div className="sp-section">
                <div className="sp-section__title">Médicaments</div>
                <div className="sp-stack sp-stack--compact">
                  {medicationRows.map((item) => (
                    <div key={item.key} className="sp-inline-card">
                      <div className="sp-inline-card__title">{item.denomination}</div>
                      {item.posologie ? <div className="sp-inline-card__meta">Posologie : {item.posologie}</div> : null}
                      {item.quantite ? <div className="sp-inline-card__meta">Quantité : {item.quantite}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="sp-section">
              <details
                key={messagingDisclosureResetKey}
                className="sp-disclosure sp-disclosure--thread"
                defaultOpen={messagingDisclosureDefaultOpen}
              >
                <summary>
                  <span className="sp-disclosure__summary-copy">
                    <span className="sp-disclosure__summary-title">Échanges avec le médecin</span>
                    {messagingDisclosureSummary ? (
                      <span className="sp-disclosure__summary-meta">{messagingDisclosureSummary}</span>
                    ) : null}
                  </span>
                </summary>
                <div className="sp-disclosure__content sp-disclosure__content--thread">
                  <MessageThread
                    prescriptionId={detailId}
                    viewerRole="PATIENT"
                    currentUserRoles={currentUserRoles}
                    title=""
                    subtitle={messagingSubtitle}
                    loading={messagesLoading}
                    emptyText={messagingLocked ? '' : messagingEmptyText}
                    messages={messages}
                    fileIndex={fileIndex}
                    onDownloadFile={onDownloadMessageAttachment}
                    canCompose={!messagingLocked}
                    readOnlyNotice={messagingReadOnlyNotice}
                    hideComposerWhenReadOnly={messagingLocked}
                    postMessage={postPatientMessage}
                    onMessageCreated={onMessageCreated}
                    onSurfaceError={onThreadSurfaceError}
                  />
                </div>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
