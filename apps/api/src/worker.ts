import './tracing.js';
import './instrument.js';
import { createTxSubmitWorker } from './queue.js';
import { pool } from './db.js';
import { logger } from './lib/logger.js';

const worker = createTxSubmitWorker();

worker.on('completed', (job) => {
  logger.info(
    { jobId: job.id, method: job.data.method, importerId: job.data.importerId },
    `[worker] job ${job.id} completed`
  );
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, `[worker] job ${job?.id} failed`);
});

process.on('SIGTERM', async () => {
  logger.info('[worker] SIGTERM received, shutting down gracefully...');
  await worker.close();
  await pool.end();
  process.exit(0);
});

logger.info('[worker] started, waiting for jobs...');
