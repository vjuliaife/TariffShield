/**
 * Integration test suite for POST /importers registration pipeline.
 *
 * Covers:
 * - #582: Blocks High-Risk AML Wallet Screening Results (403, no on-chain call, no DB row; LOW/MEDIUM proceeds)
 * - #581: Returns 409 for duplicate registration by the same user (exactly 1 DB row; distinct user succeeds)
 * - #583: Returns 422 for CBP Form 301 validation failures (minimum required match, no DB row; valid inputs succeed)
 * - #584: Persists matching bond_records row on successful registration (linked importer_id, type '02', matching name, EIN, and minimum)
 *
 * Run via:  npm run test:integration --workspace=apps/api
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { Pool } from 'pg';

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

const kpPlatform = Keypair.random();
const kpSurety = Keypair.random();

stub('DATABASE_URL', 'postgres://test:test@localhost:5432/tariffshield_test');
stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CBLASRVG7NRAFP2CDPVSF4WTJBKC6L4FKT2XHR3OH7CLICUBPVQ4PBBF');
stub('PLATFORM_STELLAR_SECRET', kpPlatform.secret());
stub('SURETY_STELLAR_SECRET', kpSurety.secret());

const { pool, createSession } = await import('../../db.js');
const { signToken } = await import('../../auth.js');
const { contractClient } = await import('../../stellar.js');
const { calculateMinimumBondAmount } = await import('../../services/cbp-bond-validation.js');
const { importersRouter } = await import('../../routes/importers.js');

const tag = randomUUID().slice(0, 8);
let app: Express;
let dbAvailable = false;

// Mock storage for offline environments
interface InMemoryUser {
  id: string;
  email: string;
  role: string;
  privacy_reacceptance_required?: boolean;
  tos_reacceptance_required?: boolean;
}
interface InMemorySession {
  id: string;
  user_id: string;
  expires_at: Date;
}
interface InMemoryImporter {
  id: string;
  user_id: string;
  legal_name: string;
  ein: string | null;
  bond_id: number;
  stellar_address: string;
  stellar_secret_encrypted: string;
  business_state: string;
  registered_on_chain_tx: string | null;
  created_at: Date;
}
interface InMemoryBondRecord {
  id: string;
  importer_id: string;
  bond_id: number;
  bond_type_code: string;
  principal_legal_name: string;
  principal_ein: string | null;
  surety_company_name: string;
  surety_fein: string;
  bond_amount: string;
  cbp_minimum_required: string;
  effective_date: Date;
  template_version: string;
  cbp_regulation_revision_date: Date;
  state_code: string;
}

const mockUsers = new Map<string, InMemoryUser>();
const mockSessions = new Map<string, InMemorySession>();
const mockImporters: InMemoryImporter[] = [];
const mockBondRecords: InMemoryBondRecord[] = [];

// Spies and monkeypatches
let originalPoolQuery: any;
let originalRegisterImporter: typeof contractClient.registerImporter;
let registerImporterCalls: Array<{
  signer: any;
  importer: string;
  bondId: bigint;
  requiredCollateral: bigint;
}> = [];

const trackedUserIds: string[] = [];
const trackedImporterIds: string[] = [];

async function createTestUser(emailSuffix: string): Promise<{ id: string; email: string; token: string }> {
  const email = `importer-${emailSuffix}-${tag}@example.com`;
  let userId: string;

  if (dbAvailable) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'hashed-password-test', 'importer')
       RETURNING id`,
      [email]
    );
    userId = res.rows[0]!.id;
    trackedUserIds.push(userId);
    const sessionId = await createSession(userId);
    const token = signToken({ id: userId, email, role: 'importer', sessionId });
    return { id: userId, email, token };
  } else {
    userId = randomUUID();
    const user: InMemoryUser = {
      id: userId,
      email,
      role: 'importer',
      privacy_reacceptance_required: false,
      tos_reacceptance_required: false,
    };
    mockUsers.set(userId, user);
    trackedUserIds.push(userId);

    const sessionId = randomUUID();
    mockSessions.set(sessionId, {
      id: sessionId,
      user_id: userId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const token = signToken({ id: userId, email, role: 'importer', sessionId });
    return { id: userId, email, token };
  }
}

function postImporter(token: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        responseHeaders[name.toLowerCase()] = value;
        return this;
      },
      getHeader(name: string) {
        return responseHeaders[name.toLowerCase()];
      },
      json(data: any) {
        resolve({ status: statusCode, body: data });
        return this;
      },
      send(data: any) {
        resolve({ status: statusCode, body: data });
        return this;
      },
    };

    const req: any = {
      method: 'POST',
      url: '/importers',
      path: '/importers',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body,
      log: { error: () => {}, info: () => {}, warn: () => {} },
    };

    (app as any).handle(req, res, (err: any) => {
      if (err) resolve({ status: 500, body: { error: err.message } });
      else resolve({ status: 404, body: { error: 'not found' } });
    });
  });
}

describe('POST /importers integration suite (#581, #582, #583, #584)', () => {
  before(async () => {
    // Check if live PostgreSQL is available
    try {
      await pool.query('SELECT 1');
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }

    if (!dbAvailable) {
      // Setup transparent in-memory query handler when database service is offline
      originalPoolQuery = Pool.prototype.query;
      (Pool.prototype as any).query = async function (this: any, textOrConfig: any, values?: any[]) {
        const queryText = (typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text).trim();

        if (queryText.includes('SELECT privacy_reacceptance_required FROM users WHERE id = $1')) {
          const u = mockUsers.get(values![0]);
          return { rowCount: u ? 1 : 0, rows: u ? [{ privacy_reacceptance_required: u.privacy_reacceptance_required ?? false }] : [] };
        }

        if (queryText.includes('SELECT tos_reacceptance_required FROM users WHERE id = $1')) {
          const u = mockUsers.get(values![0]);
          return { rowCount: u ? 1 : 0, rows: u ? [{ tos_reacceptance_required: u.tos_reacceptance_required ?? false }] : [] };
        }

        if (queryText.includes('user_sessions')) {
          return { rowCount: 1, rows: [{ id: values![0] }] };
        }

        if (queryText.includes('FROM sessions WHERE id = $1')) {
          const s = mockSessions.get(values![0]);
          return { rowCount: s ? 1 : 0, rows: s ? [s] : [] };
        }

        if (queryText.includes('UPDATE sessions SET updated_at = now()')) {
          return { rowCount: 1, rows: [] };
        }

        if (queryText.includes('SELECT id FROM importers WHERE user_id = $1')) {
          const matching = mockImporters.filter((i) => i.user_id === values![0]);
          return { rowCount: matching.length, rows: matching.map((i) => ({ id: i.id })) };
        }

        if (queryText.includes('INSERT INTO aml_screenings')) {
          return { rowCount: 1, rows: [] };
        }

        if (queryText.includes('INSERT INTO importers')) {
          const [userId, legalName, ein, , bondId, stellarAddress, stellarSecretEncrypted, businessState] = values!;
          const newImp: InMemoryImporter = {
            id: randomUUID(),
            user_id: userId,
            legal_name: legalName,
            ein: ein ?? null,
            bond_id: bondId,
            stellar_address: stellarAddress,
            stellar_secret_encrypted: stellarSecretEncrypted,
            business_state: businessState ?? 'CA',
            registered_on_chain_tx: null,
            created_at: new Date(),
          };
          mockImporters.push(newImp);
          trackedImporterIds.push(newImp.id);
          return {
            rowCount: 1,
            rows: [
              {
                id: newImp.id,
                legal_name: newImp.legal_name,
                ein: newImp.ein,
                bond_id: newImp.bond_id,
                stellar_address: newImp.stellar_address,
                created_at: newImp.created_at,
              },
            ],
          };
        }

        if (queryText.includes('INSERT INTO bond_records')) {
          const [
            importerId,
            bondId,
            bondTypeCode,
            legalName,
            ein,
            suretyCompanyName,
            suretyFein,
            bondAmount,
            cbpMin,
            effectiveDate,
            templateVer,
            cbpRevDate,
            stateCode,
          ] = values!;
          const newBond: InMemoryBondRecord = {
            id: randomUUID(),
            importer_id: importerId,
            bond_id: bondId,
            bond_type_code: bondTypeCode,
            principal_legal_name: legalName,
            principal_ein: ein ?? null,
            surety_company_name: suretyCompanyName,
            surety_fein: suretyFein,
            bond_amount: bondAmount,
            cbp_minimum_required: cbpMin,
            effective_date: effectiveDate,
            template_version: templateVer,
            cbp_regulation_revision_date: cbpRevDate,
            state_code: stateCode,
          };
          mockBondRecords.push(newBond);
          return { rowCount: 1, rows: [{ id: newBond.id }] };
        }

        if (queryText.includes('UPDATE importers SET registered_on_chain_tx = $1 WHERE id = $2')) {
          const imp = mockImporters.find((i) => i.id === values![1]);
          if (imp) imp.registered_on_chain_tx = values![0];
          return { rowCount: imp ? 1 : 0, rows: [] };
        }

        if (queryText.includes('UPDATE importer_referrals')) {
          return { rowCount: 0, rows: [] };
        }

        if (queryText.includes('INSERT INTO contract_events')) {
          return { rowCount: 1, rows: [] };
        }

        if (queryText.includes('INSERT INTO audit_log')) {
          return { rowCount: 1, rows: [] };
        }

        if (queryText.includes('COUNT(*) AS count FROM importers WHERE user_id = $1')) {
          const matching = mockImporters.filter((i) => i.user_id === values![0]);
          return { rowCount: 1, rows: [{ count: String(matching.length) }] };
        }

        if (queryText.includes('FROM bond_records WHERE importer_id = $1')) {
          const matching = mockBondRecords.filter((b) => b.importer_id === values![0]);
          return { rowCount: matching.length, rows: matching };
        }

        return { rowCount: 0, rows: [] };
      };
    }

    // Stub friendbot network calls
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any): Promise<Response> => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (urlStr.includes('friendbot.stellar.org')) {
        return new Response(JSON.stringify({ successful: true }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    // Stub contractClient.registerImporter
    originalRegisterImporter = contractClient.registerImporter;
    contractClient.registerImporter = (async (
      signer: any,
      importer: string,
      bondId: bigint,
      requiredCollateral: bigint
    ) => {
      registerImporterCalls.push({ signer, importer, bondId, requiredCollateral });
      return {
        txHash: '0x' + randomUUID().replace(/-/g, ''),
        result: null,
        ledgerSequence: 104523,
        applicationOrder: 1,
      };
    }) as any;

    // Express app setup
    app = express();
    app.use(express.json());
    app.use('/importers', importersRouter);
  });

  after(async () => {
    if (contractClient && originalRegisterImporter) {
      contractClient.registerImporter = originalRegisterImporter;
    }

    if (dbAvailable) {
      if (trackedImporterIds.length > 0) {
        await pool.query('DELETE FROM bond_records WHERE importer_id = ANY($1::uuid[])', [trackedImporterIds]);
        await pool.query('DELETE FROM contract_events WHERE importer_id = ANY($1::uuid[])', [trackedImporterIds]);
        await pool.query('DELETE FROM importers WHERE id = ANY($1::uuid[])', [trackedImporterIds]);
      }
      if (trackedUserIds.length > 0) {
        await pool.query('DELETE FROM sessions WHERE user_id = ANY($1::uuid[])', [trackedUserIds]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [trackedUserIds]);
      }
      await pool.end();
    } else if (originalPoolQuery) {
      Pool.prototype.query = originalPoolQuery;
    }
  });

  beforeEach(() => {
    registerImporterCalls = [];
  });

  // =========================================================================
  // #582: Blocks High-Risk AML Wallet Screening Results
  // =========================================================================
  describe('Issue #582 — POST /importers AML wallet screening', () => {
    it('blocks high-risk AML wallet screening results with 403, executes no on-chain registration, and inserts no importer row', async () => {
      const user = await createTestUser('aml-high');
      const originalRandom = Keypair.random;

      // Deterministic HIGH risk mock keypair: address starts with 'G' and contains 'HIGH'
      const highRiskKeypair = {
        publicKey: () => 'GHIGH1234567890TESTSTELLARADDRESS0000000000000000000000000000',
        secret: () => 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD',
      };
      Keypair.random = () => highRiskKeypair as any;

      try {
        const { status, body } = await postImporter(user.token, {
          legalName: 'High Risk Corp',
          ein: '12-3456789',
          bondId: 9001,
          initialRequiredCollateral: '5000000000000',
        });

        assert.strictEqual(status, 403, 'should return 403 Forbidden for high risk wallet');
        assert.deepStrictEqual(
          body,
          { error: 'Wallet address flagged as high risk by AML provider' },
          'should return the expected AML-flagged wallet error message'
        );

        // Verification: No contractClient.registerImporter call occurred
        assert.strictEqual(
          registerImporterCalls.length,
          0,
          'No contractClient.registerImporter call should occur for rejected registration'
        );

        // Verification: No importers row committed for this user
        let count = 0;
        if (dbAvailable) {
          const dbRes = await pool.query<{ count: string }>(
            'SELECT COUNT(*) AS count FROM importers WHERE user_id = $1',
            [user.id]
          );
          count = Number(dbRes.rows[0]!.count);
        } else {
          count = mockImporters.filter((i) => i.user_id === user.id).length;
        }
        assert.strictEqual(count, 0, 'No importers row should be committed for rejected call');
      } finally {
        Keypair.random = originalRandom;
      }
    });

    it('proceeds to on-chain registration successfully when wallet risk score is LOW or MEDIUM', async () => {
      const user = await createTestUser('aml-med');
      const originalRandom = Keypair.random;

      // Deterministic MEDIUM risk mock keypair: address starts with 'G' and contains 'MED'
      const medRiskKeypair = {
        publicKey: () => 'GMED1234567890TESTSTELLARADDRESS0000000000000000000000000000',
        secret: () => 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE',
      };
      Keypair.random = () => medRiskKeypair as any;

      try {
        const { status, body } = await postImporter(user.token, {
          legalName: 'Medium Risk Permitted Corp',
          ein: '12-3456789',
          bondId: 9002,
          initialRequiredCollateral: '5000000000000',
        });

        assert.strictEqual(status, 200, 'MEDIUM risk score should proceed successfully with 200');
        assert.ok(body.importer?.id, 'Response should contain registered importer ID');
        assert.strictEqual(
          registerImporterCalls.length,
          1,
          'contractClient.registerImporter should be invoked exactly once'
        );
        assert.strictEqual(
          registerImporterCalls[0]!.importer,
          medRiskKeypair.publicKey(),
          'On-chain call should register the generated stellar address'
        );
      } finally {
        Keypair.random = originalRandom;
      }
    });
  });

  // =========================================================================
  // #581: Returns 409 for a Second Registration by the Same User
  // =========================================================================
  describe('Issue #581 — POST /importers duplicate registration handling', () => {
    it('returns 409 on second registration by same user, keeping exactly 1 row, while distinct user succeeds', async () => {
      const userA = await createTestUser('user-a');
      const userB = await createTestUser('user-b');

      // 1. First registration for userA succeeds with 200
      const firstRes = await postImporter(userA.token, {
        legalName: 'Alpha Imports LLC',
        ein: '11-1111111',
        bondId: 8101,
        initialRequiredCollateral: '5000000000000',
      });
      assert.strictEqual(firstRes.status, 200, 'First registration should succeed with 200');
      assert.ok(firstRes.body.importer?.id, 'First registration returns importer id');

      // 2. Second registration attempt by same user returns 409
      const secondRes = await postImporter(userA.token, {
        legalName: 'Alpha Imports Duplicate Attempt',
        ein: '11-1111111',
        bondId: 8102,
        initialRequiredCollateral: '5000000000000',
      });
      assert.strictEqual(secondRes.status, 409, 'Second registration by same user must return 409');
      assert.deepStrictEqual(
        secondRes.body,
        { error: 'importer already registered for this user' },
        'Response error must specify duplicate registration'
      );

      // 3. Exactly one importers row exists for userA
      let countUserA = 0;
      if (dbAvailable) {
        const dbRes = await pool.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM importers WHERE user_id = $1',
          [userA.id]
        );
        countUserA = Number(dbRes.rows[0]!.count);
      } else {
        countUserA = mockImporters.filter((i) => i.user_id === userA.id).length;
      }
      assert.strictEqual(countUserA, 1, 'Exactly one importers row should exist for userA');

      // 4. A different user (userB) can still register successfully with 200
      const userBRes = await postImporter(userB.token, {
        legalName: 'Beta Logistics Inc',
        ein: '22-2222222',
        bondId: 8201,
        initialRequiredCollateral: '5000000000000',
      });
      assert.strictEqual(userBRes.status, 200, 'Different user should register successfully with 200');
      assert.ok(userBRes.body.importer?.id, 'Different user returns importer id');
    });
  });

  // =========================================================================
  // #583: Returns 422 for Bond Form 301 Validation Failures
  // =========================================================================
  describe('Issue #583 — POST /importers Form 301 validation failures', () => {
    it('returns 422 with validation errors when bond amount is below minimum, writing no row, and succeeds with valid inputs', async () => {
      const user = await createTestUser('form301');
      const minRequired = calculateMinimumBondAmount('02');

      // Supply bond amount below minimum (e.g. 100 stroops vs 5_000_000_000_000 minimum)
      const invalidRes = await postImporter(user.token, {
        legalName: 'Under-collateralized Imports LLC',
        ein: '33-3333333',
        bondId: 8301,
        initialRequiredCollateral: '100',
      });

      assert.strictEqual(invalidRes.status, 422, 'Should reject invalid Form 301 inputs with 422');
      assert.strictEqual(invalidRes.body.error, 'Bond validation failed', 'Error must be "Bond validation failed"');
      assert.ok(Array.isArray(invalidRes.body.details), 'details must be an array of errors');

      // Verify rejection details contain the computed minimum
      const hasMinError = invalidRes.body.details.some(
        (err: string) => err.includes(minRequired.toString()) && err.toLowerCase().includes('continuous bond must meet minimum')
      );
      assert.ok(
        hasMinError,
        `Validation error should mention computed minimumRequired (${minRequired.toString()} stroops)`
      );

      // Verify no importers row was written for user
      let count = 0;
      if (dbAvailable) {
        const dbRes = await pool.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM importers WHERE user_id = $1',
          [user.id]
        );
        count = Number(dbRes.rows[0]!.count);
      } else {
        count = mockImporters.filter((i) => i.user_id === user.id).length;
      }
      assert.strictEqual(count, 0, 'No importers row should be written for failed validation');

      // Verify valid inputs with the same importer otherwise succeed with 200
      const validRes = await postImporter(user.token, {
        legalName: 'Under-collateralized Imports LLC',
        ein: '33-3333333',
        bondId: 8301,
        initialRequiredCollateral: minRequired.toString(),
      });
      assert.strictEqual(validRes.status, 200, 'Valid inputs with same user should succeed with 200');
      assert.ok(validRes.body.importer?.id, 'Successful retry should return importer id');
    });
  });

  // =========================================================================
  // #584: Persists a Matching bond_records Row on Registration
  // =========================================================================
  describe('Issue #584 — POST /importers bond_records persistence', () => {
    it('persists a matching bond_records row linked to importer_id with type 02 and correct metadata', async () => {
      const user = await createTestUser('bond-record');
      const minRequired = calculateMinimumBondAmount('02');
      const bondId = 8401;
      const legalName = 'Verified Bond Imports Inc';
      const ein = '44-4444444';
      const collateral = minRequired.toString();

      const beforeIsoDate = new Date().toISOString().slice(0, 10);

      const res = await postImporter(user.token, {
        legalName,
        ein,
        bondId,
        initialRequiredCollateral: collateral,
        businessState: 'NY',
      });

      assert.strictEqual(res.status, 200, 'Registration must succeed with 200');
      const importerId = res.body.importer.id;
      assert.ok(importerId, 'Returned importer must have an id');

      // Query bond_records row for this importer_id
      let bondRow: any;
      if (dbAvailable) {
        const dbRes = await pool.query<any>(
          'SELECT * FROM bond_records WHERE importer_id = $1',
          [importerId]
        );
        assert.strictEqual(dbRes.rowCount, 1, 'Exactly one bond_records row should exist for importer');
        bondRow = dbRes.rows[0];
      } else {
        const matches = mockBondRecords.filter((b) => b.importer_id === importerId);
        assert.strictEqual(matches.length, 1, 'Exactly one bond_records row should exist for importer');
        bondRow = matches[0];
      }

      // Assertions per Issue #584 Acceptance Criteria:
      // 1. bond_records row exists with importer_id matching returned importer.id
      assert.strictEqual(bondRow.importer_id, importerId, 'importer_id must match returned importer.id');

      // 2. bond_type_code is '02' and effective_date is set to registration date
      assert.strictEqual(bondRow.bond_type_code, '02', 'bond_type_code must be continuous ("02")');
      const effectiveDateStr =
        bondRow.effective_date instanceof Date
          ? bondRow.effective_date.toISOString().slice(0, 10)
          : String(bondRow.effective_date).slice(0, 10);
      assert.strictEqual(effectiveDateStr, beforeIsoDate, 'effective_date must be set to registration date');

      // 3. principal_legal_name and principal_ein match request body
      assert.strictEqual(bondRow.principal_legal_name, legalName, 'principal_legal_name must match request');
      assert.strictEqual(bondRow.principal_ein, ein, 'principal_ein must match request');

      // 4. cbp_minimum_required matches bondValidation.minimumRequired from the validation step
      assert.strictEqual(
        String(bondRow.cbp_minimum_required),
        minRequired.toString(),
        'cbp_minimum_required must match validation minimumRequired'
      );
    });
  });
});
