import type { RowDataPacket } from 'mysql2/promise';
import type { DbClient } from './mysql.js';

export type JobRow = RowDataPacket & { job_id: string; req_id: string | null; payload: string; mls1_token: string; attempts: number };

export class JobsRepo {
  constructor(private readonly db: DbClient, private readonly table = process.env['JOBS_TABLE'] ?? 'wp_sosprescription_jobs') {}

  async claimNext(lockSeconds = 600): Promise<JobRow | null> {
    const conn = await this.db.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<JobRow[]>(`SELECT job_id, req_id, payload, mls1_token, attempts FROM ${this.table} WHERE status='PENDING' AND available_at<=NOW(3) ORDER BY priority ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const job = rows[0];
      if (!job) {
        await conn.commit();
        return null;
      }

      await conn.execute(`UPDATE ${this.table} SET status='CLAIMED', locked_at=NOW(3), lock_expires_at=DATE_ADD(NOW(3), INTERVAL ? SECOND), locked_by=? WHERE job_id=?`, [lockSeconds, process.env['DYNO'] ?? 'worker.1', job.job_id]);
      await conn.commit();
      return job;
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async markDone(jobId: string, s3KeyRef: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.table} SET status='DONE', s3_key_ref=?, completed_at=NOW(3), locked_at=NULL, lock_expires_at=NULL, locked_by=NULL WHERE job_id=?`, [s3KeyRef, jobId]);
  }

  async markFailed(jobId: string, code: string, messageSafe: string): Promise<void> {
    await this.db.execute(`UPDATE ${this.table} SET status='FAILED', last_error_code=?, last_error_message_safe=?, last_error_at=NOW(3), completed_at=NOW(3), locked_at=NULL, lock_expires_at=NULL, locked_by=NULL WHERE job_id=?`, [code, messageSafe.slice(0, 255), jobId]);
  }
}
