import { randomUUID, createHash } from "node:crypto";
import type { MysqlPool, MysqlConn } from "./mysql";

export type JobStatus = "PENDING" | "CLAIMED" | "DONE" | "FAILED";

export interface JobRow {
  job_id: string;
  site_id: string;
  req_id: string | null;
  job_type: string;
  status: JobStatus;
  priority: number;
  available_at: Date;
  rx_id: number;
  nonce: string;
  kid: string | null;
  exp_ms: string;
  payload: unknown;
  payload_sha256: Buffer;
  mls1_token: string;
  s3_key_ref: string | null;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  lock_expires_at: Date | null;
  locked_by: string | null;
  last_error_code: string | null;
  last_error_message_safe: string | null;
}

export interface QueueMetrics {
  pending: number;
  claimed: number;
}

export class JobsRepo {
  private readonly table: string;

  constructor(
    private readonly pool: MysqlPool,
    private readonly tablePrefix: string,
  ) {
    this.table = `${tablePrefix}sosprescription_jobs`;
  }

  getTableName(): string {
    return this.table;
  }

  async claimNextPendingJob(opts: {
    siteId: string;
    workerId: string;
    leaseMinutes: number;
  }): Promise<JobRow | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      let jobId: string | null = null;

      try {
        const [rows] = await conn.query(
          `
          SELECT job_id
          FROM \`${this.table}\`
          WHERE site_id = ?
            AND status = 'PENDING'
            AND available_at <= NOW(3)
          ORDER BY available_at ASC, priority ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
          `,
          [opts.siteId],
        );

        jobId = (rows as { job_id: string }[]).length ? (rows as { job_id: string }[])[0].job_id : null;
      } catch (_err) {
        const [rows] = await conn.query(
          `
          SELECT job_id
          FROM \`${this.table}\`
          WHERE site_id = ?
            AND status = 'PENDING'
            AND available_at <= NOW(3)
          ORDER BY available_at ASC, priority ASC, created_at ASC
          LIMIT 1
          FOR UPDATE
          `,
          [opts.siteId],
        );
        jobId = (rows as { job_id: string }[]).length ? (rows as { job_id: string }[])[0].job_id : null;
      }

      if (!jobId) {
        await conn.commit();
        return null;
      }

      const [upd] = await conn.execute(
        `
        UPDATE \`${this.table}\`
        SET status = 'CLAIMED',
            locked_at = NOW(3),
            lock_expires_at = DATE_ADD(NOW(3), INTERVAL ? MINUTE),
            locked_by = ?,
            attempts = attempts + 1
        WHERE job_id = ?
          AND status = 'PENDING'
        `,
        [opts.leaseMinutes, opts.workerId, jobId],
      );

      if ((upd as { affectedRows?: number }).affectedRows !== 1) {
        await conn.commit();
        return null;
      }

      const job = await this.getJobByIdConn(conn, jobId);
      await conn.commit();
      return job;
    } catch (_err) {
      await conn.rollback();
      throw _err;
    } finally {
      conn.release();
    }
  }

  async getJobById(jobId: string): Promise<JobRow | null> {
    const conn = await this.pool.getConnection();
    try {
      return await this.getJobByIdConn(conn, jobId);
    } finally {
      conn.release();
    }
  }

  private async getJobByIdConn(conn: MysqlConn, jobId: string): Promise<JobRow | null> {
    const [rows] = await conn.query(
      `SELECT * FROM \`${this.table}\` WHERE job_id = ? LIMIT 1`,
      [jobId],
    );
    return (rows as JobRow[]).length ? (rows as JobRow[])[0] : null;
  }

  async markDone(opts: {
    jobId: string;
    s3KeyRef: string;
    artifactSha256: Buffer;
    artifactSizeBytes: number;
    contentType: string;
  }): Promise<void> {
    await this.pool.execute(
      `
      UPDATE \`${this.table}\`
      SET status = 'DONE',
          s3_key_ref = ?,
          artifact_sha256 = ?,
          artifact_size_bytes = ?,
          artifact_content_type = ?,
          completed_at = NOW(3),
          locked_at = NULL,
          lock_expires_at = NULL,
          locked_by = NULL
      WHERE job_id = ?
      `,
      [opts.s3KeyRef, opts.artifactSha256, opts.artifactSizeBytes, opts.contentType, opts.jobId],
    );
  }

  async markFailed(opts: {
    jobId: string;
    errorCode: string;
    messageSafe: string;
  }): Promise<void> {
    await this.pool.execute(
      `
      UPDATE \`${this.table}\`
      SET status = 'FAILED',
          last_error_code = ?,
          last_error_message_safe = ?,
          last_error_at = NOW(3),
          completed_at = NOW(3),
          locked_at = NULL,
          lock_expires_at = NULL,
          locked_by = NULL
      WHERE job_id = ?
      `,
      [opts.errorCode, opts.messageSafe, opts.jobId],
    );
  }

  async requeueWithBackoff(opts: {
    jobId: string;
    delaySeconds: number;
    errorCode: string;
    messageSafe: string;
  }): Promise<void> {
    const delay = Math.max(1, Math.min(opts.delaySeconds, 900));
    await this.pool.execute(
      `
      UPDATE \`${this.table}\`
      SET status = 'PENDING',
          available_at = DATE_ADD(NOW(3), INTERVAL ${delay} SECOND),
          last_error_code = ?,
          last_error_message_safe = ?,
          last_error_at = NOW(3),
          locked_at = NULL,
          lock_expires_at = NULL,
          locked_by = NULL
      WHERE job_id = ?
      `,
      [opts.errorCode, opts.messageSafe, opts.jobId],
    );
  }

  async getQueueMetrics(siteId: string): Promise<QueueMetrics> {
    const [rows] = await this.pool.query(
      `
      SELECT
        SUM(status='PENDING') AS pending,
        SUM(status='CLAIMED') AS claimed
      FROM \`${this.table}\`
      WHERE site_id = ?
      `,
      [siteId],
    );

    return (rows as { pending: number; claimed: number }[]).length ? (rows as { pending: number; claimed: number }[])[0] : { pending: 0, claimed: 0 };
  }

  async sweepZombies(siteId: string, limit = 50): Promise<{ requeued: number; failed: number }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      let zombies: { job_id: string; attempts: number; max_attempts: number }[] = [];
      try {
        const [rows] = await conn.query(
          `
          SELECT job_id, attempts, max_attempts
          FROM \`${this.table}\`
          WHERE site_id = ?
            AND status = 'CLAIMED'
            AND lock_expires_at IS NOT NULL
            AND lock_expires_at < NOW(3)
          ORDER BY lock_expires_at ASC
          LIMIT ${Math.max(1, Math.min(limit, 500))}
          FOR UPDATE SKIP LOCKED
          `,
          [siteId],
        );
        zombies = rows as { job_id: string; attempts: number; max_attempts: number }[];
      } catch (_err) {
        const [rows] = await conn.query(
          `
          SELECT job_id, attempts, max_attempts
          FROM \`${this.table}\`
          WHERE site_id = ?
            AND status = 'CLAIMED'
            AND lock_expires_at IS NOT NULL
            AND lock_expires_at < NOW(3)
          ORDER BY lock_expires_at ASC
          LIMIT ${Math.max(1, Math.min(limit, 500))}
          FOR UPDATE
          `,
          [siteId],
        );
        zombies = rows as { job_id: string; attempts: number; max_attempts: number }[];
      }

      let requeued = 0;
      let failed = 0;

      for (const z of zombies) {
        if (z.attempts >= z.max_attempts) {
          await conn.execute(
            `
            UPDATE \`${this.table}\`
            SET status='FAILED',
                last_error_code='ML_ZOMBIE_MAX_ATTEMPTS',
                last_error_message_safe='Job failed after repeated lease expirations',
                last_error_at=NOW(3),
                completed_at=NOW(3),
                locked_at=NULL,
                lock_expires_at=NULL,
                locked_by=NULL
            WHERE job_id = ?
            `,
            [z.job_id],
          );
          failed++;
        } else {
          await conn.execute(
            `
            UPDATE \`${this.table}\`
            SET status='PENDING',
                available_at=DATE_ADD(NOW(3), INTERVAL 30 SECOND),
                last_error_code='ML_ZOMBIE_REQUEUED',
                last_error_message_safe='Requeued after expired lease',
                last_error_at=NOW(3),
                locked_at=NULL,
                lock_expires_at=NULL,
                locked_by=NULL
            WHERE job_id = ?
            `,
            [z.job_id],
          );
          requeued++;
        }
      }

      await conn.commit();
      return { requeued, failed };
    } catch (_err) {
      await conn.rollback();
      throw _err;
    } finally {
      conn.release();
    }
  }
}

export function sha256Bytes(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

export function newJobId(): string {
  return randomUUID();
}
