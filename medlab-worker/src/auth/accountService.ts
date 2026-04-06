import { ActorRole, Prisma, PrismaClient } from "@prisma/client";
import { NdjsonLogger } from "../logger";

let prismaSingleton: PrismaClient | null = null;

type SupportedActorRole = "DOCTOR" | "PATIENT";

export interface AccountServiceConfig {
  logger?: NdjsonLogger;
}

export interface DeleteAccountResult {
  deleted: boolean;
  actorRole: SupportedActorRole;
  accountId: string | null;
  authTokensRevoked: number;
  notFound: boolean;
}

export class AccountServiceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccountServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AccountService {
  private readonly prisma: PrismaClient;
  private readonly logger?: NdjsonLogger;

  constructor(cfg: AccountServiceConfig = {}) {
    this.prisma = getPrismaClient();
    this.logger = cfg.logger;
  }

  async deleteAccount(actor: ActorRole, wpUserId: number, reqId?: string): Promise<DeleteAccountResult> {
    const actorRole = normalizeActorRole(actor);
    const normalizedWpUserId = normalizePositiveInt(wpUserId, "wpUserId");

    try {
      const result = actorRole === ActorRole.DOCTOR
        ? await this.deleteDoctor(normalizedWpUserId)
        : await this.deletePatient(normalizedWpUserId);

      this.logger?.info(
        "account.delete.completed",
        {
          actor_role: actorRole,
          owner_wp_user_id: normalizedWpUserId,
          account_id: result.accountId,
          deleted: result.deleted,
          not_found: result.notFound,
          auth_tokens_revoked: result.authTokensRevoked,
        },
        reqId,
      );

      return result;
    } catch (err: unknown) {
      if (err instanceof AccountServiceError) {
        throw err;
      }

      this.logger?.error(
        "account.delete.failed",
        {
          actor_role: actorRole,
          owner_wp_user_id: normalizedWpUserId,
          reason: err instanceof Error ? err.message : "account_delete_failed",
        },
        reqId,
        err,
      );

      throw new AccountServiceError(
        "ML_ACCOUNT_DELETE_FAILED",
        500,
        "account_delete_failed",
        { cause: err instanceof Error ? err : undefined },
      );
    }
  }

  private async deletePatient(wpUserId: number): Promise<DeleteAccountResult> {
    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findUnique({
        where: { wpUserId },
        select: {
          id: true,
          email: true,
          deletedAt: true,
        },
      });

      const authTokensRevoked = await revokeAuthTokens(tx, wpUserId, patient?.email ?? null);
      if (!patient) {
        return {
          deleted: true,
          actorRole: ActorRole.PATIENT,
          accountId: null,
          authTokensRevoked,
          notFound: true,
        } satisfies DeleteAccountResult;
      }

      const now = new Date();
      await tx.patient.update({
        where: { id: patient.id },
        data: {
          deletedAt: now,
          email: buildDeletedEmail(patient.id),
          phone: null,
          weightKg: null,
          heightCm: null,
          note: null,
          wpUserId: null,
        },
      });

      return {
        deleted: true,
        actorRole: ActorRole.PATIENT,
        accountId: patient.id,
        authTokensRevoked,
        notFound: false,
      } satisfies DeleteAccountResult;
    });
  }

  private async deleteDoctor(wpUserId: number): Promise<DeleteAccountResult> {
    return this.prisma.$transaction(async (tx) => {
      const doctor = await tx.doctor.findUnique({
        where: { wpUserId },
        select: {
          id: true,
          email: true,
          deletedAt: true,
        },
      });

      const authTokensRevoked = await revokeAuthTokens(tx, wpUserId, doctor?.email ?? null);
      if (!doctor) {
        return {
          deleted: true,
          actorRole: ActorRole.DOCTOR,
          accountId: null,
          authTokensRevoked,
          notFound: true,
        } satisfies DeleteAccountResult;
      }

      const now = new Date();
      await tx.doctor.update({
        where: { id: doctor.id },
        data: {
          deletedAt: now,
          email: buildDeletedEmail(doctor.id),
          phone: null,
          address: null,
          city: null,
          zipCode: null,
          wpUserId: null,
        },
      });

      return {
        deleted: true,
        actorRole: ActorRole.DOCTOR,
        accountId: doctor.id,
        authTokensRevoked,
        notFound: false,
      } satisfies DeleteAccountResult;
    });
  }
}

function getPrismaClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }

  return prismaSingleton;
}

async function revokeAuthTokens(
  tx: Prisma.TransactionClient,
  wpUserId: number,
  email: string | null,
): Promise<number> {
  const clauses: Prisma.AuthTokenWhereInput[] = [{ ownerWpUserId: wpUserId }];
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== "") {
    clauses.push({
      email: {
        equals: normalizedEmail,
        mode: "insensitive",
      },
    });
  }

  const result = await tx.authToken.updateMany({
    where: { OR: clauses },
    data: { used: true },
  });

  return result.count;
}

function normalizeActorRole(value: ActorRole): SupportedActorRole {
  if (value === ActorRole.DOCTOR || value === ActorRole.PATIENT) {
    return value;
  }

  throw new AccountServiceError("ML_ACCOUNT_DELETE_BAD_REQUEST", 400, "account_actor_invalid");
}

function normalizePositiveInt(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AccountServiceError("ML_ACCOUNT_DELETE_BAD_REQUEST", 400, `${field} is invalid`);
  }

  return Math.trunc(value);
}

function normalizeEmail(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "" ? "" : normalized;
}

function buildDeletedEmail(accountId: string): string {
  const normalizedId = String(accountId || "").trim().toLowerCase();
  if (normalizedId === "") {
    throw new AccountServiceError("ML_ACCOUNT_DELETE_FAILED", 500, "account_id_missing");
  }

  return `deleted_${normalizedId}@sosprescription.local`;
}
