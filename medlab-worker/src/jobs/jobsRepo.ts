// src/jobs/jobsRepo.ts
export type QueueMode = "rest" | "postgres";
export type JobStatus = "WAITING_APPROVAL" | "PENDING" | "CLAIMED" | "DONE" | "FAILED";

export interface JobRow {
  id?: number | string;
  job_id: string;
  site_id: string;
  req_id: string | null;
  job_type: string;
  status: JobStatus;
  priority: number;
  available_at: string | null;
  rx_id: number;
  nonce: string;
  kid: string | null;
  exp_ms: string;
  payload?: unknown;
  payload_json?: string;
  mls1_token: string;
  s3_key_ref: string | null;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  lock_expires_at: string | null;
  locked_by: string | null;
  worker_ref?: string | null;
  verify_token?: string | null;
  doctor_id?: string | null;
  patient_id?: string | null;
  source_req_id?: string | null;
}

export interface QueueMetrics {
  pending: number;
  claimed: number;
}

export interface ClaimJobOptions {
  siteId: string;
  workerId: string;
  leaseMinutes: number;
}

export interface MarkDoneOptions {
  jobId: string;
  reqId?: string;
  workerRef?: string;
  s3KeyRef: string;
  s3Bucket?: string;
  s3Region?: string;
  artifactSha256Hex: string;
  artifactSizeBytes: number;
  contentType: string;
}

export interface MarkFailedOptions {
  jobId: string;
  reqId?: string;
  workerRef?: string;
  errorCode: string;
  messageSafe: string;
}

export interface RequeueWithBackoffOptions {
  jobId: string;
  reqId?: string;
  workerRef?: string;
  delaySeconds: number;
  errorCode: string;
  messageSafe: string;
}

export interface UpdateJobStatusInput {
  jobId: string;
  reqId?: string;
  workerRef?: string;
  status: "DONE" | "FAILED" | "PENDING";
  s3KeyRef?: string;
  s3Bucket?: string;
  s3Region?: string;
  artifactSha256Hex?: string;
  artifactSizeBytes?: number;
  artifactContentType?: string;
  errorCode?: string;
  lastErrorMessageSafe?: string;
  retryAfterSeconds?: number;
}

export interface SweepZombiesResult {
  requeued: number;
  failed: number;
}

export interface IngestDoctorInput {
  wpUserId?: number | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  twilioPhone?: string | null;
  university?: string | null;
  distinctions?: string | null;
  title?: string | null;
  specialty?: string | null;
  rpps?: string | null;
  amNumber?: string | null;
  address?: string | null;
  city?: string | null;
  zipCode?: string | null;
  signatureS3Key?: string | null;
}

export interface IngestPatientInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  gender?: string | null;
  email?: string | null;
  phone?: string | null;
  weightKg?: string | null;
  weight_kg?: string | null;
}

export interface IngestPrescriptionPayload {
  items: unknown[];
  privateNotes?: string | null;
}

export interface IngestPrescriptionRequest {
  schema_version: string;
  site_id: string;
  ts_ms: number;
  nonce: string;
  req_id: string;
  doctor?: IngestDoctorInput | null;
  patient: IngestPatientInput;
  prescription: IngestPrescriptionPayload;
}

export interface IngestPrescriptionResult {
  mode: "created" | "replay";
  job_id: string;
  prescription_id: string;
  uid: string;
  verify_token: string | null;
  verify_code: string | null;
  processing_status: JobStatus;
  status: string;
  source_req_id: string;
}

export interface PaymentActionPayload {
  action: "capture" | "cancel";
  provider?: string | null;
  wp_prescription_id?: number | null;
  payment_intent_id: string;
  payment_status?: string | null;
  amount_cents?: number | string | null;
  currency?: string | null;
  uid?: string | null;
  priority?: string | null;
  flow?: string | null;
}

export interface ApprovePrescriptionRequest {
  schema_version: string;
  site_id: string;
  ts_ms: number;
  nonce: string;
  req_id: string;
  doctor: IngestDoctorInput;
  items?: unknown[] | null;
  payment?: PaymentActionPayload | null;
}

export interface ApprovePrescriptionResult {
  mode: "approved" | "replay";
  job_id: string;
  prescription_id: string;
  uid: string;
  verify_token: string | null;
  verify_code: string | null;
  processing_status: JobStatus;
  status: string;
  source_req_id: string;
}

export interface RejectPrescriptionRequest {
  schema_version: string;
  site_id: string;
  ts_ms: number;
  nonce: string;
  req_id: string;
  reason?: string | null;
  payment?: PaymentActionPayload | null;
}

export interface RejectPrescriptionResult {
  mode: "rejected" | "replay";
  job_id: string;
  prescription_id: string;
  uid: string;
  verify_token: string | null;
  verify_code: string | null;
  processing_status: JobStatus;
  status: string;
  source_req_id: string;
}

export interface JobsRepo {
  readonly mode: QueueMode;
  getTableName(): string;
  claimNextPendingJob(opts: ClaimJobOptions): Promise<JobRow | null>;
  markDone(opts: MarkDoneOptions): Promise<void>;
  markFailed(opts: MarkFailedOptions): Promise<void>;
  requeueWithBackoff(opts: RequeueWithBackoffOptions): Promise<void>;
  getQueueMetrics(siteId: string): Promise<QueueMetrics>;
  sweepZombies(siteId: string, limit?: number): Promise<SweepZombiesResult>;
  ingestPrescription(input: IngestPrescriptionRequest): Promise<IngestPrescriptionResult>;
  approvePrescription(prescriptionId: string, input: ApprovePrescriptionRequest): Promise<ApprovePrescriptionResult>;
  rejectPrescription(prescriptionId: string, input: RejectPrescriptionRequest): Promise<RejectPrescriptionResult>;
  close(): Promise<void>;
}
