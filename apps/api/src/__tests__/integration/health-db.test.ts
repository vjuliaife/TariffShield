/**
 * Tests for the pool configuration and GET /health/db endpoint added by #241,
 * plus the liveness/readiness probe contracts (#621-623).
 *
 * Run via: node --import tsx/esm --test src/__tests__/integration/health-db.test.ts
 *
 * getPoolStats() only reads pg.Pool's own counters (never opens a real
 * connection to read them), so these run without a live PostgreSQL instance.
 * The env stubs mirror apps/api/src/migrate.ts's approach for running
 * non-DB-dependent code paths without a full .env.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HealthDependencies } from '../../routes/health.js';

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

// Unconditional, unlike stub() below: this whole file tests behavior against
// an unreachable database, so it must win even when the CI job already sets
// a real (reachable) DATABASE_URL at the job level for the other test files
// in this suite that need it.
process.env.DATABASE_URL = 'postgres://fake:fake@localhost:1/fake';
stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { getPoolStats, pool } = await import('../../db.js');

describe('db pool configuration (#241)', () => {
  it("getPoolStats returns the pool's own counters without opening a connection", () => {
    const stats = getPoolStats();
    assert.equal(typeof stats.totalCount, 'number');
    assert.equal(typeof stats.idleCount, 'number');
    assert.equal(typeof stats.waitingCount, 'number');
    // No connection has been attempted yet, so all counters start at 0.
    assert.equal(stats.totalCount, 0);
    assert.equal(stats.idleCount, 0);
    assert.equal(stats.waitingCount, 0);
  });

  it('pool.query rejects against an unreachable database instead of hanging', async () => {
    await assert.rejects(() => pool.query('SELECT 1'));
  });
});

describe('GET /health/db route (#241)', () => {
  it('reports status degraded with pool stats when the database is unreachable', async () => {
    const { healthRouter } = await import('../../routes/health.js');
    const layer = (healthRouter.stack as any[]).find(
      (l) => l.route?.path === '/db' && l.route.methods.get
    );
    assert.ok(layer, 'GET /db route must be registered on healthRouter');

    const handler = layer.route.stack[0].handle;
    let statusCode = 200;
    let body: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    };

    await handler({} as any, res as any, (() => {}) as any);

    assert.equal(statusCode, 503);
    assert.deepEqual(body, {
      status: 'degraded',
      db: 'failed',
      pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    });
  });
});

async function requestHealth(path: string, dependencies: HealthDependencies) {
  const { createHealthRouter } = await import('../../routes/health.js');
  const server = createServer(express().use('/health', createHealthRouter(dependencies)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${address.port}/health${path}`, {
      headers: { connection: 'close' },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('GET /health/live and /health/ready probes (#621-623)', () => {
  it('/health reports the database failure while preserving independent checks', async () => {
    const response = await requestHealth('/', {
      ping: async () => {
        throw new Error('database unavailable');
      },
      pingRpc: async () => {},
      pingRedis: async () => {},
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.db, 'failed');
    assert.equal(body.soroban, 'ok');
    assert.equal(body.redis, 'connected');
  });

  it('/health reports version and network details when all dependencies are available', async () => {
    const response = await requestHealth('/', {
      ping: async () => {},
      pingRpc: async () => {},
      pingRedis: async () => {},
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.equal(body.contractId, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(body.network, 'testnet');
  });

  it('/live returns immediate plain-text 200 without calling any dependency', async () => {
    const calls = { db: 0, soroban: 0, redis: 0 };
    const dependencies: HealthDependencies = {
      ping: async () => {
        calls.db++;
        throw new Error('database unavailable');
      },
      pingRpc: async () => {
        calls.soroban++;
        throw new Error('Soroban unavailable');
      },
      pingRedis: async () => {
        calls.redis++;
        throw new Error('Redis unavailable');
      },
    };

    const response = await requestHealth('/live', dependencies);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain(?:;|$)/);
    assert.equal(await response.text(), 'OK');
    assert.deepEqual(calls, { db: 0, soroban: 0, redis: 0 });
  });

  for (const [dependency, failing] of [
    ['db', 'ping'],
    ['soroban', 'pingRpc'],
    ['redis', 'pingRedis'],
  ] as const) {
    it(`/ready returns plain-text 503 when ${dependency} is unavailable`, async () => {
      const calls = { ping: 0, pingRpc: 0, pingRedis: 0 };
      const dependencies: HealthDependencies = {
        ping: async () => {
          calls.ping++;
          if (failing === 'ping') throw new Error(`${dependency} unavailable`);
        },
        pingRpc: async () => {
          calls.pingRpc++;
          if (failing === 'pingRpc') throw new Error(`${dependency} unavailable`);
        },
        pingRedis: async () => {
          calls.pingRedis++;
          if (failing === 'pingRedis') throw new Error(`${dependency} unavailable`);
        },
      };

      const response = await requestHealth('/ready', dependencies);

      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain(?:;|$)/);
      assert.equal(await response.text(), 'Service Unavailable');
      assert.deepEqual(calls, { ping: 1, pingRpc: 1, pingRedis: 1 });
    });
  }

  it('/ready returns plain-text 200 when all dependencies are available', async () => {
    const response = await requestHealth('/ready', {
      ping: async () => {},
      pingRpc: async () => {},
      pingRedis: async () => {},
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain(?:;|$)/);
    assert.equal(await response.text(), 'OK');
  });
});
