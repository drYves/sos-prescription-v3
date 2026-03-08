import { setTimeout as sleep } from 'node:timers/promises';
import { MemoryGuard } from './admission/memoryGuard.js';
import { createDbClient } from './db/mysql.js';
import { JobsRepo } from './db/jobsRepo.js';
import { PdfRenderer } from './pdf/pdfRenderer.js';
import { S3Service } from './s3/s3Service.js';
import { startPulseServer } from './http/pulseServer.js';

type JobPayload = { job: { job_id: string; rx_id: number } };

async function main(): Promise<void> {
  const db = createDbClient();
  const repo = new JobsRepo(db);
  const renderer = new PdfRenderer();
  const s3 = new S3Service();
  const guard = new MemoryGuard(512, 450);

  startPulseServer(Number(process.env['WORKER_PULSE_PORT'] ?? process.env['PORT'] ?? 3000));

  while (true) {
    if (!guard.canRun()) {
      await sleep(2000);
      continue;
    }

    const job = await repo.claimNext();
    if (!job) {
      await sleep(1000);
      continue;
    }

    try {
      const payload = JSON.parse(job.payload) as JobPayload;
      const html = `<html><body><h1>Prescription #${payload.job.rx_id}</h1></body></html>`;
      const pdf = await renderer.render({ html });
      const month = new Date().toISOString().slice(0, 7).replace('-', '/');
      const key = `unit/${process.env['ML_SITE_ID'] ?? 'unknown_site'}/rx-pdf/${month}/${job.job_id}.pdf`;
      await s3.uploadPdf(key, pdf);
      await repo.markDone(job.job_id, key);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown-error';
      await repo.markFailed(job.job_id, 'PDF_RENDER_FAILED', message);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
