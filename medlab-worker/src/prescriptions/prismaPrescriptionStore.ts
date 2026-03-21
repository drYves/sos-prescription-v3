// src/prescriptions/prismaPrescriptionStore.ts
import { PrismaClient } from "@prisma/client";
import { HardError } from "../jobs/errors";
import { NdjsonLogger } from "../logger";

export interface RenderDoctor {
  id: string;
  wpUserId: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  specialty: string | null;
  rpps: string | null;
  amNumber: string | null;
  address: string | null;
  city: string | null;
  zipCode: string | null;
  signatureS3Key: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderPatient {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RenderPrescription {
  id: string;
  uid: string;
  status: string;
  items: unknown;
  privateNotes: string | null;
  s3PdfKey: string | null;
  verifyCode: string | null;
  verifyToken: string | null;
  processingStatus: string;
  availableAt: Date;
  claimedAt: Date | null;
  lockExpiresAt: Date | null;
  workerRef: string | null;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  lastErrorMessageSafe: string | null;
  sourceReqId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrescriptionRenderAggregate {
  doctor: RenderDoctor;
  patient: RenderPatient;
  prescription: RenderPrescription;
}

export interface PrismaPrescriptionStoreConfig {
  prisma?: PrismaClient;
  logger?: NdjsonLogger;
}

export class PrismaPrescriptionStore {
  private readonly prisma: PrismaClient;
  private readonly ownsClient: boolean;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: PrismaPrescriptionStoreConfig = {}) {
    this.prisma = cfg.prisma ?? new PrismaClient();
    this.ownsClient = !cfg.prisma;
    this.logger = cfg.logger;
  }

  async getRenderablePrescription(prescriptionId: string): Promise<PrescriptionRenderAggregate> {
    const id = String(prescriptionId ?? "").trim();
    if (id === "") {
      throw new HardError("ML_PRESCRIPTION_NOT_FOUND", "Prescription not found");
    }

    const row = await this.prisma.prescription.findUnique({
      where: { id },
      include: {
        doctor: true,
        patient: true,
      },
    });

    if (!row) {
      this.logger?.warning("db.prescription.not_found", { prescription_id: id }, undefined);
      throw new HardError("ML_PRESCRIPTION_NOT_FOUND", "Prescription not found");
    }

    return {
      doctor: {
        id: row.doctor.id,
        wpUserId: row.doctor.wpUserId,
        firstName: row.doctor.firstName,
        lastName: row.doctor.lastName,
        email: row.doctor.email,
        phone: row.doctor.phone,
        title: row.doctor.title,
        specialty: row.doctor.specialty,
        rpps: row.doctor.rpps,
        amNumber: row.doctor.amNumber,
        address: row.doctor.address,
        city: row.doctor.city,
        zipCode: row.doctor.zipCode,
        signatureS3Key: row.doctor.signatureS3Key,
        createdAt: row.doctor.createdAt,
        updatedAt: row.doctor.updatedAt,
      },
      patient: {
        id: row.patient.id,
        firstName: row.patient.firstName,
        lastName: row.patient.lastName,
        birthDate: row.patient.birthDate,
        gender: row.patient.gender,
        email: row.patient.email,
        phone: row.patient.phone,
        createdAt: row.patient.createdAt,
        updatedAt: row.patient.updatedAt,
      },
      prescription: {
        id: row.id,
        uid: row.uid,
        status: row.status,
        items: row.items,
        privateNotes: row.privateNotes,
        s3PdfKey: row.s3PdfKey,
        verifyCode: row.verifyCode,
        verifyToken: row.verifyToken,
        processingStatus: row.processingStatus,
        availableAt: row.availableAt,
        claimedAt: row.claimedAt,
        lockExpiresAt: row.lockExpiresAt,
        workerRef: row.workerRef,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastErrorCode: row.lastErrorCode,
        lastErrorMessageSafe: row.lastErrorMessageSafe,
        sourceReqId: row.sourceReqId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  }

  async close(): Promise<void> {
    if (!this.ownsClient) {
      return;
    }
    await this.prisma.$disconnect();
  }
}
