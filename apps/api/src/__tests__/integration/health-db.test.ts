/**
 * Tests for the pool configuration and GET /health/db endpoint added by #241,
 * and the JSON bodies of GET /health/live and /health/ready (#973).
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

// #973 — /live and /ready return JSON with a `status` field, like / and /db.
function findGetHandler(healthRouter: any, path: string) {
  const layer = (healthRouter.stack as any[]).find(
    (l) => l.route?.path === path && l.route.methods.get
  );
  assert.ok(layer, `GET ${path} route must be registered on healthRouter`);
  return layer.route.stack[0].handle;
}

function mockRes() {
  const captured: { statusCode: number; body: unknown } = { statusCode: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  };
  return { res, captured };
}

describe('GET /health/live and /health/ready JSON bodies (#973)', () => {
  it('/live returns 200 with { status: "ok" }', async () => {
    const { healthRouter } = await import('../../routes/health.js');
    const { res, captured } = mockRes();
    await findGetHandler(healthRouter, '/live')({} as any, res as any, (() => {}) as any);
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(captured.body, { status: 'ok' });
  });

  it('/ready returns 503 with { status: "degraded" } when a dependency is unreachable', async () => {
    const { healthRouter } = await import('../../routes/health.js');
    const { res, captured } = mockRes();
    await findGetHandler(healthRouter, '/ready')({} as any, res as any, (() => {}) as any);
    assert.equal(captured.statusCode, 503);
    assert.deepEqual(captured.body, { status: 'degraded' });
  });
});
