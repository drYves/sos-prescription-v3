// src/messages/messagesRepo.ts
import { ActorRole, ArtifactKind, ArtifactStatus, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 4_000;

export interface MessagesRepoConfig {
  logger?: NdjsonLogger;
}

export interface MessageActorInput {
  role: ActorRole;
  wpUserId?: number | null;
}

export interface AddMessageInput {
  prescriptionId: string;
  actor: MessageActorInput;
  body?: string | null;
  attachmentArtifactIds?: string[] | null;
}

export interface GetThreadInput {
  prescriptionId: string;
  actor: MessageActorInput;
  afterSeq?: number | null;
  limit?: number | null;
}

export interface MarkAsReadInput {
  prescriptionId: string;
  actor: MessageActorInput;
  readUptoSeq?: number | null;
}

export interface EnsureThreadWritableInput {
  prescriptionId: string;
  actor: MessageActorInput;
}

export interface ThreadAttachmentRecord {
  id: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  linkedAt: Date | null;
}

export interface ThreadMessageRecord {
  id: string;
  seq: number;
  authorRole: ActorRole;
  authorWpUserId: number | null;
  authorDoctorId: string | null;
  body: string;
  createdAt: Date;
  attachments: ThreadAttachmentRecord[];
}

export type ThreadMode = "DOCTOR_ONLY" | "PATIENT_REPLY" | "READ_ONLY";

export interface ThreadState {
  mode: ThreadMode;
  messageCount: number;
  lastMessageSeq: number;
  lastMessageAt: Date | null;
  lastMessageRole: ActorRole | null;
  doctorLastReadSeq: number;
  patientLastReadSeq: number;
  unreadCountDoctor: number;
  unreadCountPatient: number;
}

export interface AddMessageResult {
  message: ThreadMessageRecord;
  threadState: ThreadState;
}

export interface GetThreadResult {
  threadState: ThreadState;
  messages: ThreadMessageRecord[];
}

export interface MarkAsReadResult {
  threadState: ThreadState;
}

export class MessagesRepoError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message?: string) {
    super(message ?? code);
    this.name = "MessagesRepoError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type LockedPrescriptionRow = {
  id: string;
  status: string;
  doctorId: string | null;
  patientId: string;
  messageCount: number;
  lastMessageSeq: number;
  lastMessageAt: Date | null;
  lastMessageRole: ActorRole | null;
  doctorLastReadSeq: number;
  patientLastReadSeq: number;
  unreadCountDoctor: number;
  unreadCountPatient: number;
  doctorWpUserId: number | null;
  patientWpUserId: number | null;
};

type PrescriptionProjection = {
  id: string;
  status: string;
  messageCount: number;
  lastMessageSeq: number;
  lastMessageAt: Date | null;
  lastMessageRole: ActorRole | null;
  doctorLastReadSeq: number;
  patientLastReadSeq: number;
  unreadCountDoctor: number;
  unreadCountPatient: number;
  doctorWpUserId: number | null;
  patientWpUserId: number | null;
};

type AttachmentProjection = {
  id: string;
  prescriptionId: string | null;
  messageId: string | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  ownerRole: ActorRole;
  ownerWpUserId: number | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  linkedAt: Date | null;
  deletedAt: Date | null;
};

export class MessagesRepo {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: MessagesRepoConfig = {}) {
    this.prisma = new PrismaClient();
    this.logger = cfg.logger;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async addMessage(input: AddMessageInput): Promise<AddMessageResult> {
    const prescriptionId = normalizeRequiredString(input.prescriptionId, "prescriptionId");
    const actor = normalizeActorInput(input.actor);
    const attachmentArtifactIds = normalizeArtifactIds(input.attachmentArtifactIds);
    const body = normalizeMessageBody(input.body);

    if (body === "" && attachmentArtifactIds.length < 1) {
      throw new MessagesRepoError(
        "ML_MESSAGE_EMPTY",
        400,
        "A message body or at least one attachment is required",
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await lockPrescription(tx, prescriptionId);
      assertActorCanAccessPrescription(locked, actor);

      const lockedThreadState = buildThreadStateFromLockedPrescription(locked);
      assertActorCanWriteThread(lockedThreadState, actor);

      const now = new Date();
      const nextSeq = locked.lastMessageSeq + 1;
      const authorDoctorId = resolveAuthorDoctorId(locked, actor);

      const created = await tx.prescriptionMessage.create({
        data: {
          prescriptionId,
          seq: nextSeq,
          authorRole: actor.role,
          authorWpUserId: actor.wpUserId,
          authorDoctorId,
          body,
          createdAt: now,
        },
        select: messageBaseSelect(),
      });

      if (attachmentArtifactIds.length > 0) {
        await linkMessageAttachments(tx, {
          prescriptionId,
          messageId: created.id,
          actor,
          artifactIds: attachmentArtifactIds,
          linkedAt: now,
        });
      }

      await tx.prescription.update({
        where: { id: prescriptionId },
        data: buildThreadUpdateDataAfterMessage(actor.role, nextSeq, now),
      });

      const attachments = attachmentArtifactIds.length > 0
        ? await tx.artifact.findMany({
            where: {
              messageId: created.id,
              deletedAt: null,
            },
            orderBy: { createdAt: "asc" },
            select: attachmentSelect(),
          })
        : [];

      return {
        message: mapMessage({ ...created, attachments }),
        threadState: buildThreadStateAfterMessage(locked, actor.role, nextSeq, now),
      };
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    this.logger?.info(
      "messages.added",
      {
        prescription_id: prescriptionId,
        seq: result.message.seq,
        author_role: result.message.authorRole,
        author_wp_user_id: result.message.authorWpUserId,
        attachments_count: result.message.attachments.length,
        unread_count_doctor: result.threadState.unreadCountDoctor,
        unread_count_patient: result.threadState.unreadCountPatient,
      },
      undefined,
    );

    return result;
  }

  async ensureThreadWritable(input: EnsureThreadWritableInput): Promise<ThreadState> {
    const prescriptionId = normalizeRequiredString(input.prescriptionId, "prescriptionId");
    const actor = normalizeActorInput(input.actor);

    const projection = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      select: prescriptionProjectionSelect(),
    });

    if (!projection) {
      throw new MessagesRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "Prescription not found");
    }

    assertActorCanAccessPrescription(projection, actor);

    const threadState = mapThreadState(projection);
    assertActorCanWriteThread(threadState, actor);

    return threadState;
  }

  async getThread(input: GetThreadInput): Promise<GetThreadResult> {
    const prescriptionId = normalizeRequiredString(input.prescriptionId, "prescriptionId");
    const actor = normalizeActorInput(input.actor);
    const afterSeq = normalizeNonNegativeInt(input.afterSeq, 0);
    const limit = normalizeLimit(input.limit);

    const projection = await this.prisma.prescription.findUnique({
      where: { id: prescriptionId },
      select: prescriptionProjectionSelect(),
    });

    if (!projection) {
      throw new MessagesRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "Prescription not found");
    }

    assertActorCanAccessPrescription(projection, actor);

    const messages = await this.prisma.prescriptionMessage.findMany({
      where: {
        prescriptionId,
        seq: { gt: afterSeq },
      },
      orderBy: { seq: "asc" },
      take: limit,
      select: messageWithAttachmentsSelect(),
    });

    const result: GetThreadResult = {
      threadState: mapThreadState(projection),
      messages: messages.map(mapMessage),
    };

    this.logger?.info(
      "messages.thread.fetched",
      {
        prescription_id: prescriptionId,
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
        after_seq: afterSeq,
        limit,
        returned_count: result.messages.length,
        unread_count_doctor: result.threadState.unreadCountDoctor,
        unread_count_patient: result.threadState.unreadCountPatient,
      },
      undefined,
    );

    return result;
  }

  async markAsRead(input: MarkAsReadInput): Promise<MarkAsReadResult> {
    const prescriptionId = normalizeRequiredString(input.prescriptionId, "prescriptionId");
    const actor = normalizeActorInput(input.actor);
    const requestedReadSeq = normalizeNonNegativeInt(input.readUptoSeq, 0);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await lockPrescription(tx, prescriptionId);
      assertActorCanAccessPrescription(locked, actor);

      const effectiveReadSeq = Math.max(
        actor.role === ActorRole.DOCTOR ? locked.doctorLastReadSeq : actor.role === ActorRole.PATIENT ? locked.patientLastReadSeq : 0,
        requestedReadSeq,
        locked.lastMessageSeq,
      );

      await tx.prescription.update({
        where: { id: prescriptionId },
        data: buildThreadUpdateDataAfterRead(actor.role, effectiveReadSeq),
      });

      return {
        threadState: buildThreadStateAfterRead(locked, actor.role, effectiveReadSeq),
      };
    }, {
      maxWait: TX_MAX_WAIT_MS,
      timeout: TX_TIMEOUT_MS,
    });

    this.logger?.info(
      "messages.read",
      {
        prescription_id: prescriptionId,
        actor_role: actor.role,
        actor_wp_user_id: actor.wpUserId,
        unread_count_doctor: result.threadState.unreadCountDoctor,
        unread_count_patient: result.threadState.unreadCountPatient,
      },
      undefined,
    );

    return result;
  }
}

async function lockPrescription(
  tx: Prisma.TransactionClient,
  prescriptionId: string,
): Promise<LockedPrescriptionRow> {
  const rows = await tx.$queryRaw<LockedPrescriptionRow[]>`
    SELECT
      p."id",
      p."status",
      p."doctorId",
      p."patientId",
      p."messageCount",
      p."lastMessageSeq",
      p."lastMessageAt",
      p."lastMessageRole",
      p."doctorLastReadSeq",
      p."patientLastReadSeq",
      p."unreadCountDoctor",
      p."unreadCountPatient",
      d."wpUserId" AS "doctorWpUserId",
      pt."wpUserId" AS "patientWpUserId"
    FROM "Prescription" p
    LEFT JOIN "Doctor" d ON d."id" = p."doctorId"
    LEFT JOIN "Patient" pt ON pt."id" = p."patientId"
    WHERE p."id" = ${prescriptionId}
    FOR UPDATE
  `;

  if (rows.length !== 1) {
    throw new MessagesRepoError("ML_PRESCRIPTION_NOT_FOUND", 404, "Prescription not found");
  }

  return rows[0];
}

function resolveThreadMode(status: string, messageCount: number): ThreadMode {
  const normalizedStatus = normalizePrescriptionStatus(status);
  if (normalizedStatus === "APPROVED" || normalizedStatus === "REJECTED") {
    return "READ_ONLY";
  }

  if (messageCount < 1) {
    return "DOCTOR_ONLY";
  }

  return "PATIENT_REPLY";
}

function normalizePrescriptionStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function buildThreadStateFromLockedPrescription(locked: LockedPrescriptionRow): ThreadState {
  return {
    mode: resolveThreadMode(locked.status, locked.messageCount),
    messageCount: locked.messageCount,
    lastMessageSeq: locked.lastMessageSeq,
    lastMessageAt: locked.lastMessageAt,
    lastMessageRole: locked.lastMessageRole,
    doctorLastReadSeq: locked.doctorLastReadSeq,
    patientLastReadSeq: locked.patientLastReadSeq,
    unreadCountDoctor: locked.unreadCountDoctor,
    unreadCountPatient: locked.unreadCountPatient,
  };
}

function assertActorCanWriteThread(threadState: ThreadState, actor: { role: ActorRole; wpUserId: number | null }): void {
  if (actor.role === ActorRole.SYSTEM) {
    return;
  }

  if (threadState.mode === "READ_ONLY") {
    throw new MessagesRepoError("ML_MESSAGE_THREAD_READ_ONLY", 409, "Thread is read-only");
  }

  if (actor.role === ActorRole.PATIENT && threadState.mode === "DOCTOR_ONLY") {
    throw new MessagesRepoError("ML_MESSAGE_DOCTOR_INIT_REQUIRED", 403, "Doctor must open the thread first");
  }
}

function assertActorCanAccessPrescription(
  projection: (
    Pick<PrescriptionProjection, "doctorWpUserId" | "patientWpUserId">
    | {
        doctor?: { wpUserId: number | null } | null;
        patient?: { wpUserId: number | null } | null;
      }
  ),
  actor: { role: ActorRole; wpUserId: number | null },
): void {
  const doctorWpUserId = "doctorWpUserId" in projection
    ? projection.doctorWpUserId
    : projection.doctor?.wpUserId ?? null;
  const patientWpUserId = "patientWpUserId" in projection
    ? projection.patientWpUserId
    : projection.patient?.wpUserId ?? null;

  switch (actor.role) {
    case ActorRole.DOCTOR:
      if (actor.wpUserId == null || (doctorWpUserId != null && doctorWpUserId !== actor.wpUserId)) {
        throw new MessagesRepoError("ML_MESSAGE_FORBIDDEN", 403, "Doctor cannot access this prescription thread");
      }
      return;
    case ActorRole.PATIENT:
      if (actor.wpUserId == null || patientWpUserId !== actor.wpUserId) {
        throw new MessagesRepoError("ML_MESSAGE_FORBIDDEN", 403, "Patient cannot access this prescription thread");
      }
      return;
    case ActorRole.SYSTEM:
      return;
    default:
      throw new MessagesRepoError("ML_MESSAGE_FORBIDDEN", 403, "Unsupported actor role");
  }
}

function resolveAuthorDoctorId(
  projection: Pick<LockedPrescriptionRow, "doctorId" | "doctorWpUserId">,
  actor: { role: ActorRole; wpUserId: number | null },
): string | null {
  if (actor.role !== ActorRole.DOCTOR) {
    return null;
  }

  if (projection.doctorId && projection.doctorWpUserId === actor.wpUserId) {
    return projection.doctorId;
  }

  return null;
}

async function linkMessageAttachments(
  tx: Prisma.TransactionClient,
  input: {
    prescriptionId: string;
    messageId: string;
    actor: { role: ActorRole; wpUserId: number | null };
    artifactIds: string[];
    linkedAt: Date;
  },
): Promise<void> {
  const artifacts = await tx.artifact.findMany({
    where: {
      id: { in: input.artifactIds },
    },
    select: attachmentValidationSelect(),
  });

  if (artifacts.length !== input.artifactIds.length) {
    throw new MessagesRepoError(
      "ML_MESSAGE_ATTACHMENT_INVALID",
      400,
      "One or more attachments were not found",
    );
  }

  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

  for (const artifactId of input.artifactIds) {
    const artifact = byId.get(artifactId);
    if (!artifact) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        400,
        "One or more attachments were not found",
      );
    }

    if (artifact.deletedAt) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        400,
        "Attachment has been deleted",
      );
    }

    if (artifact.kind !== ArtifactKind.MESSAGE_ATTACHMENT) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        400,
        "Only MESSAGE_ATTACHMENT artifacts can be attached to messages",
      );
    }

    if (artifact.status !== ArtifactStatus.READY) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        400,
        "Attachment is not ready yet",
      );
    }

    if (artifact.messageId) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        409,
        "Attachment is already linked to another message",
      );
    }

    if (artifact.prescriptionId && artifact.prescriptionId !== input.prescriptionId) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        400,
        "Attachment belongs to another prescription",
      );
    }

    if (input.actor.role !== ActorRole.SYSTEM) {
      if (artifact.ownerRole !== input.actor.role || artifact.ownerWpUserId !== input.actor.wpUserId) {
        throw new MessagesRepoError(
          "ML_MESSAGE_ATTACHMENT_INVALID",
          403,
          "Attachment owner does not match the message author",
        );
      }
    }

    const linked = await tx.artifact.updateMany({
      where: {
        id: artifact.id,
        status: ArtifactStatus.READY,
        messageId: null,
        deletedAt: null,
      },
      data: {
        prescriptionId: input.prescriptionId,
        messageId: input.messageId,
        linkedAt: input.linkedAt,
      },
    });

    if (linked.count !== 1) {
      throw new MessagesRepoError(
        "ML_MESSAGE_ATTACHMENT_INVALID",
        409,
        "Attachment could not be linked safely",
      );
    }
  }
}

function buildThreadUpdateDataAfterMessage(
  role: ActorRole,
  nextSeq: number,
  now: Date,
): Prisma.PrescriptionUpdateInput {
  const data: Prisma.PrescriptionUpdateInput = {
    messageCount: { increment: 1 },
    lastMessageSeq: nextSeq,
    lastMessageAt: now,
    lastMessageRole: role,
    updatedAt: now,
  };

  switch (role) {
    case ActorRole.DOCTOR:
      data.doctorLastReadSeq = nextSeq;
      data.unreadCountDoctor = 0;
      data.unreadCountPatient = { increment: 1 };
      break;
    case ActorRole.PATIENT:
      data.patientLastReadSeq = nextSeq;
      data.unreadCountPatient = 0;
      data.unreadCountDoctor = { increment: 1 };
      break;
    case ActorRole.SYSTEM:
      data.unreadCountDoctor = { increment: 1 };
      data.unreadCountPatient = { increment: 1 };
      break;
    default:
      throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "Unsupported actor role");
  }

  return data;
}

function buildThreadStateAfterMessage(
  locked: LockedPrescriptionRow,
  role: ActorRole,
  nextSeq: number,
  now: Date,
): ThreadState {
  const thread: ThreadState = {
    mode: resolveThreadMode(locked.status, locked.messageCount + 1),
    messageCount: locked.messageCount + 1,
    lastMessageSeq: nextSeq,
    lastMessageAt: now,
    lastMessageRole: role,
    doctorLastReadSeq: locked.doctorLastReadSeq,
    patientLastReadSeq: locked.patientLastReadSeq,
    unreadCountDoctor: locked.unreadCountDoctor,
    unreadCountPatient: locked.unreadCountPatient,
  };

  switch (role) {
    case ActorRole.DOCTOR:
      thread.doctorLastReadSeq = nextSeq;
      thread.unreadCountDoctor = 0;
      thread.unreadCountPatient = locked.unreadCountPatient + 1;
      break;
    case ActorRole.PATIENT:
      thread.patientLastReadSeq = nextSeq;
      thread.unreadCountPatient = 0;
      thread.unreadCountDoctor = locked.unreadCountDoctor + 1;
      break;
    case ActorRole.SYSTEM:
      thread.unreadCountDoctor = locked.unreadCountDoctor + 1;
      thread.unreadCountPatient = locked.unreadCountPatient + 1;
      break;
    default:
      throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "Unsupported actor role");
  }

  return thread;
}

function buildThreadUpdateDataAfterRead(role: ActorRole, effectiveReadSeq: number): Prisma.PrescriptionUpdateInput {
  switch (role) {
    case ActorRole.DOCTOR:
      return {
        doctorLastReadSeq: effectiveReadSeq,
        unreadCountDoctor: 0,
      };
    case ActorRole.PATIENT:
      return {
        patientLastReadSeq: effectiveReadSeq,
        unreadCountPatient: 0,
      };
    case ActorRole.SYSTEM:
      return {
        doctorLastReadSeq: effectiveReadSeq,
        patientLastReadSeq: effectiveReadSeq,
        unreadCountDoctor: 0,
        unreadCountPatient: 0,
      };
    default:
      throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "Unsupported actor role");
  }
}

function buildThreadStateAfterRead(
  locked: LockedPrescriptionRow,
  role: ActorRole,
  effectiveReadSeq: number,
): ThreadState {
  const thread: ThreadState = {
    mode: resolveThreadMode(locked.status, locked.messageCount),
    messageCount: locked.messageCount,
    lastMessageSeq: locked.lastMessageSeq,
    lastMessageAt: locked.lastMessageAt,
    lastMessageRole: locked.lastMessageRole,
    doctorLastReadSeq: locked.doctorLastReadSeq,
    patientLastReadSeq: locked.patientLastReadSeq,
    unreadCountDoctor: locked.unreadCountDoctor,
    unreadCountPatient: locked.unreadCountPatient,
  };

  switch (role) {
    case ActorRole.DOCTOR:
      thread.doctorLastReadSeq = effectiveReadSeq;
      thread.unreadCountDoctor = 0;
      break;
    case ActorRole.PATIENT:
      thread.patientLastReadSeq = effectiveReadSeq;
      thread.unreadCountPatient = 0;
      break;
    case ActorRole.SYSTEM:
      thread.doctorLastReadSeq = effectiveReadSeq;
      thread.patientLastReadSeq = effectiveReadSeq;
      thread.unreadCountDoctor = 0;
      thread.unreadCountPatient = 0;
      break;
    default:
      throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "Unsupported actor role");
  }

  return thread;
}

function prescriptionProjectionSelect() {
  return {
    id: true,
    status: true,
    messageCount: true,
    lastMessageSeq: true,
    lastMessageAt: true,
    lastMessageRole: true,
    doctorLastReadSeq: true,
    patientLastReadSeq: true,
    unreadCountDoctor: true,
    unreadCountPatient: true,
    doctor: {
      select: {
        wpUserId: true,
      },
    },
    patient: {
      select: {
        wpUserId: true,
      },
    },
  } satisfies Prisma.PrescriptionSelect;
}

function messageBaseSelect() {
  return {
    id: true,
    seq: true,
    authorRole: true,
    authorWpUserId: true,
    authorDoctorId: true,
    body: true,
    createdAt: true,
  } satisfies Prisma.PrescriptionMessageSelect;
}

function messageWithAttachmentsSelect() {
  return {
    ...messageBaseSelect(),
    attachments: {
      where: {
        deletedAt: null,
        status: ArtifactStatus.READY,
      },
      orderBy: {
        createdAt: "asc",
      },
      select: attachmentSelect(),
    },
  } satisfies Prisma.PrescriptionMessageSelect;
}

function attachmentSelect() {
  return {
    id: true,
    kind: true,
    status: true,
    originalName: true,
    mimeType: true,
    sizeBytes: true,
    createdAt: true,
    linkedAt: true,
  } satisfies Prisma.ArtifactSelect;
}

function attachmentValidationSelect() {
  return {
    id: true,
    prescriptionId: true,
    messageId: true,
    kind: true,
    status: true,
    ownerRole: true,
    ownerWpUserId: true,
    originalName: true,
    mimeType: true,
    sizeBytes: true,
    createdAt: true,
    linkedAt: true,
    deletedAt: true,
  } satisfies Prisma.ArtifactSelect;
}

function mapMessage(row: {
  id: string;
  seq: number;
  authorRole: ActorRole;
  authorWpUserId: number | null;
  authorDoctorId: string | null;
  body: string;
  createdAt: Date;
  attachments?: Array<{
    id: string;
    kind: ArtifactKind;
    status: ArtifactStatus;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
    linkedAt: Date | null;
  }>;
}): ThreadMessageRecord {
  return {
    id: row.id,
    seq: row.seq,
    authorRole: row.authorRole,
    authorWpUserId: row.authorWpUserId,
    authorDoctorId: row.authorDoctorId,
    body: row.body,
    createdAt: row.createdAt,
    attachments: (row.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      status: attachment.status,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      createdAt: attachment.createdAt,
      linkedAt: attachment.linkedAt,
    })),
  };
}

function mapThreadState(row: {
  status: string;
  messageCount: number;
  lastMessageSeq: number;
  lastMessageAt: Date | null;
  lastMessageRole: ActorRole | null;
  doctorLastReadSeq: number;
  patientLastReadSeq: number;
  unreadCountDoctor: number;
  unreadCountPatient: number;
  doctor?: { wpUserId: number | null } | null;
  patient?: { wpUserId: number | null } | null;
}): ThreadState {
  return {
    mode: resolveThreadMode(row.status, row.messageCount),
    messageCount: row.messageCount,
    lastMessageSeq: row.lastMessageSeq,
    lastMessageAt: row.lastMessageAt,
    lastMessageRole: row.lastMessageRole,
    doctorLastReadSeq: row.doctorLastReadSeq,
    patientLastReadSeq: row.patientLastReadSeq,
    unreadCountDoctor: row.unreadCountDoctor,
    unreadCountPatient: row.unreadCountPatient,
  };
}

function normalizeActorInput(input: MessageActorInput): { role: ActorRole; wpUserId: number | null } {
  if (!input || typeof input !== "object") {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "actor is required");
  }

  const role = normalizeActorRole(input.role);
  const wpUserId = normalizeNullablePositiveInt(input.wpUserId);

  if ((role === ActorRole.DOCTOR || role === ActorRole.PATIENT) && wpUserId == null) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "actor.wpUserId is required");
  }

  return { role, wpUserId };
}

function normalizeActorRole(value: unknown): ActorRole {
  const raw = normalizeRequiredString(value, "actor.role").toUpperCase();
  switch (raw) {
    case ActorRole.PATIENT:
    case ActorRole.DOCTOR:
    case ActorRole.SYSTEM:
      return raw;
    default:
      throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "actor.role is invalid");
  }
}

function normalizeMessageBody(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "message.body must be a string");
  }

  const normalized = value.trim();
  if (normalized.length > MAX_BODY_CHARS) {
    throw new MessagesRepoError(
      "ML_MESSAGE_BAD_REQUEST",
      400,
      `message.body exceeds ${MAX_BODY_CHARS} characters`,
    );
  }

  return normalized;
}

function normalizeArtifactIds(value: unknown): string[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new MessagesRepoError(
      "ML_MESSAGE_BAD_REQUEST",
      400,
      "attachment_artifact_ids must be an array",
    );
  }

  const unique = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim();
    if (normalized !== "") {
      unique.add(normalized);
    }
  }

  return Array.from(unique);
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, `${field} is required`);
  }
  return value.trim();
}

function normalizeNullablePositiveInt(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (value == null || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MessagesRepoError("ML_MESSAGE_BAD_REQUEST", 400, "Numeric parameter is invalid");
  }
  return Math.trunc(parsed);
}

function normalizeLimit(value: unknown): number {
  const parsed = normalizeNonNegativeInt(value, DEFAULT_LIMIT);
  if (parsed < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(parsed, MAX_LIMIT);
}
