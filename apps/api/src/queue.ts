import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { env } from './config/env.js';
import { pool } from './db.js';
import { contractClient, platformKeypair, suretyKeypair } from './stellar.js';
import { Keypair } from '@stellar/stellar-sdk';
import { invalidateOnChainAccount } from './cache.js';

export interface TxSubmitJobData {
  method:
    | 'deposit'
    | 'auto_top_up'
    | 'withdraw'
    | 'accrue_yield'
    | 'clawback'
    | 'set_required_collateral'
    | 'register';
  importerId: string;
  keypairSecret?: string;
  platformKey?: boolean;
  suretyKey?: boolean;
  args: Record<string, unknown>;
}

export interface TxSubmitJobResult {
  txHash: string;
  txUrl: string;
  ledgerSequence: number;
  applicationOrder: number;
}

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const txSubmitQueue = new Queue<TxSubmitJobData, TxSubmitJobResult>('tx-submit', {
  connection,
});

/**
 * Pings Redis to check connectivity (#263 — used by GET /health for load
 * balancer probes). Reuses the same connection the job queue runs on rather
 * than opening a second one.
 */
export async function pingRedis(): Promise<void> {
  const reply = await connection.ping();
  if (reply !== 'PONG') {
    throw new Error(`unexpected Redis PING reply: ${reply}`);
  }
}

export async function enqueueTxSubmit(data: TxSubmitJobData): Promise<string> {
  const job = await txSubmitQueue.add('submit', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  });
  return job.id!;
}

export function createTxSubmitWorker() {
  return new Worker<TxSubmitJobData, TxSubmitJobResult>(
    'tx-submit',
    async (job) => {
      const { method, importerId, keypairSecret, platformKey, suretyKey, args } = job.data;

      const importer = await pool
        .query('SELECT * FROM importers WHERE id = $1', [importerId])
        .then((r) => r.rows[0]);
      if (!importer) throw new Error(`importer ${importerId} not found`);

      let key: Keypair;
      if (keypairSecret) {
        key = Keypair.fromSecret(keypairSecret);
      } else if (platformKey) {
        key = platformKeypair;
      } else if (suretyKey) {
        key = suretyKeypair;
      } else {
        throw new Error('no signing key provided');
      }

      const explorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

      let onChain;
      let eventKind: string;
      let eventAmount: string | null = null;

      switch (method) {
        case 'register':
          onChain = await contractClient.registerImporter(
            key,
            args.publicKey as string,
            BigInt(args.bondId as string),
            BigInt(args.initialCollateral as string)
          );
          eventKind = 'register';
          break;
        case 'set_required_collateral':
          onChain = await contractClient.setRequiredCollateral(
            [key],
            args.importerAddress as string,
            BigInt(args.amountStroops as string),
            args.oracleContractId as string,
            false
          );
          eventKind = 'required_changed';
          eventAmount = args.amountStroops as string;
          break;
        case 'deposit':
          {
            const fn =
              args.bucket === 'collateral'
                ? contractClient.depositCollateral.bind(contractClient)
                : contractClient.depositReserve.bind(contractClient);
            onChain = await fn(
              key,
              args.importerAddress as string,
              args.sourceAddress as string,
              BigInt(args.amountStroops as string)
            );
            eventKind = args.bucket === 'collateral' ? 'deposit_collateral' : 'deposit_reserve';
            eventAmount = args.amountStroops as string;
          }
          break;
        case 'auto_top_up':
          onChain = await contractClient.autoTopUp(key, args.importerAddress as string);
          eventKind = 'auto_top_up';
          eventAmount = onChain.result.toString();
          break;
        case 'withdraw':
          onChain = await contractClient.withdrawCollateral(
            key,
            args.importerAddress as string,
            args.sourceAddress as string,
            BigInt(args.amountStroops as string)
          );
          eventKind = 'withdraw';
          eventAmount = args.amountStroops as string;
          break;
        case 'accrue_yield':
          onChain = await contractClient.accrueYield(
            key,
            args.importerAddress as string,
            BigInt(args.amountStroops as string)
          );
          eventKind = 'yield';
          eventAmount = args.amountStroops as string;
          break;
        case 'clawback':
          onChain = await contractClient.clawback(key, args.importerAddress as string);
          eventKind = 'clawback';
          eventAmount = onChain.result.toString();
          break;
      }

      // #228: bare ON CONFLICT DO NOTHING (no explicit column list) — required
      // now that contract_events is partitioned; see the doc comment on
      // createContractEventsPartition() in lib/contract-events-partitions.ts.
      await pool.query(
        `INSERT INTO contract_events (importer_id, kind, amount, tx_hash, ledger_sequence, event_index)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [
          importerId,
          eventKind,
          eventAmount,
          onChain.txHash,
          onChain.ledgerSequence,
          onChain.applicationOrder,
        ]
      );

      // #246 — the route that enqueued this job already invalidated the
      // cache once (see routes/importers.ts), but that happened before this
      // tx was confirmed on-chain. Invalidate again now, on confirmation, so
      // a GET that landed (and re-cached) in between doesn't leave stale
      // pre-write state cached for the rest of the 30s TTL.
      if (method === 'deposit' || method === 'withdraw' || method === 'clawback') {
        await invalidateOnChainAccount(importerId);
      }

      return {
        txHash: onChain.txHash,
        txUrl: explorerTx(onChain.txHash),
        ledgerSequence: onChain.ledgerSequence,
        applicationOrder: onChain.applicationOrder,
      };
    },
    {
      connection,
      // BullMQ defaults Worker concurrency to 1, which serializes every
      // queued deposit/withdraw/auto_top_up submission behind a single
      // in-flight job even when the jobs touch unrelated importer
      // accounts. That default was the dominant throughput bottleneck
      // identified in the investigation for issue #1089; see
      // docs/investigations/deposit-collateral-throughput.md for the
      // ledger-level analysis of the (much smaller) ceiling that remains
      // once this is raised.
      concurrency: env.TX_SUBMIT_WORKER_CONCURRENCY,
    }
  );
}
