import crypto from 'node:crypto';
import {
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  COMPATIBILITY_MATRIX,
  CompatibilityError,
  checkCompatibility,
  type ContractVersionRange,
} from './compatibility.js';

export interface TariffShieldAccount {
  bondId: bigint;
  collateralBalance: bigint;
  requiredCollateral: bigint;
  reserveBalance: bigint;
  yieldAccrued: bigint;
  isClawbacked: boolean;
  collateralLastUpdated: bigint;
  // #336 — dispute window fields
  disputeExpiresAt: bigint;
  preDisputeRequired: bigint;
  disputeRaised: boolean;
  // #326 / #331 — oracle update tracking
  oracleLastUpdated: bigint;
}

// #331 — one entry in the on-chain collateral audit trail
export interface CollateralHistoryEntry {
  value: bigint;
  timestamp: bigint;
}

export interface InvokeResult<T> {
  txHash: string;
  result: T;
  /** Ledger the transaction was included in — pairs with applicationOrder to uniquely identify the event. */
  ledgerSequence: number;
  /** Transaction's position within its ledger. */
  applicationOrder: number;
}

export interface TariffShieldApiOptions {
  baseUrl: string;
  apiKey?: string;
  sessionToken?: string;
}

export class TariffShieldApiClient {
  private readonly baseUrl: string;
  public readonly apiKey?: string;
  public readonly sessionToken?: string;

  constructor(opts: TariffShieldApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.sessionToken = opts.sessionToken;
  }

  getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else if (this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
    }
    return headers;
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      ...this.getHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).error || `Request failed with status ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async getImporter(importerId: string) {
    return this.request(`/importers/${importerId}`);
  }

  async getCollateralHistory(importerId: string) {
    return this.request(`/importers/${importerId}/collateral-history`);
  }

  async createDepositSchedule(
    importerId: string,
    data: { cadence: 'weekly' | 'monthly'; amountStroops: string; bucket?: string; startDate?: string }
  ) {
    return this.request(`/importers/${importerId}/deposit-schedule`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async scheduleWithdrawal(
    importerId: string,
    data: { amountStroops: string; targetDate: string; targetAddress?: string }
  ) {
    return this.request(`/importers/${importerId}/scheduled-withdrawals`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async createApiKey(data: { label?: string; scopes?: string[]; rateLimitPerMin?: number; expiresInDays?: number }) {
    return this.request('/account/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listApiKeys() {
    return this.request('/account/api-keys');
  }

  async revokeApiKey(keyId: string) {
    return this.request(`/account/api-keys/${keyId}/revoke`, {
      method: 'POST',
    });
  }

  async createWebhookSubscription(importerId: string, data: { targetUrl: string; eventTypes: string[] }) {
    return this.request(`/importers/${importerId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async listWebhookSubscriptions(importerId: string) {
    return this.request(`/importers/${importerId}/webhooks`);
  }

  async deleteWebhookSubscription(importerId: string, subId: string) {
    return this.request(`/importers/${importerId}/webhooks/${subId}`, {
      method: 'DELETE',
    });
  }

  async getWebhookDeliveryLogs(importerId: string, subId: string) {
    return this.request(`/importers/${importerId}/webhooks/${subId}/logs`);
  }
}

export function verifyWebhookSignature(
  rawPayload: string,
  headerSignature: string,
  secretKey: string
): boolean {
  if (!headerSignature || !secretKey) return false;
  const parts = headerSignature.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const signaturePart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !signaturePart) return false;

  const timestamp = timestampPart.split('=')[1];
  const expectedSig = signaturePart.split('=')[1];

  const computedSig = crypto
    .createHmac('sha256', secretKey)
    .update(`${timestamp}.${rawPayload}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(computedSig), Buffer.from(expectedSig));
}


export interface TariffShieldClientOptions {
  rpcUrl?: string;
  contractId?: string;
  networkPassphrase?: string;
  /** Optional: REST API endpoint URL */
  apiUrl?: string;
  /** Optional: API key for authenticating REST API calls (#995) */
  apiKey?: string;
  /** Optional: Session token for authenticating REST API calls */
  sessionToken?: string;
  /** Optional: allow tests to override the timeout. */
  txTimeoutSeconds?: number;
  /** Optional: custom rpc.Server instance */
  server?: rpc.Server;
  /** Optional: SDK version string for compatibility checking (defaults to "0.1.0") */
  sdkVersion?: string;
  /** Optional: skip automatic contract compatibility verification on startup */
  skipCompatibilityCheck?: boolean;
}

const DEFAULT_FEE = '1000000'; // 0.1 XLM — generous for Soroban invocations

/**
 * Wraps the deployed TariffShield Soroban contract.
 *
 * Each write method is async and returns the testnet tx hash plus the parsed
 * return value. Read methods (get_account, get_admin, get_surety, get_token)
 * are simulated only — no signing, no submission.
 */
export class TariffShieldClient {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly txTimeoutSeconds: number;
  private readonly compatibilityPromise: Promise<void> | null;
  public readonly api?: TariffShieldApiClient;

  constructor(opts: TariffShieldClientOptions) {
    if (opts.apiUrl) {
      this.api = new TariffShieldApiClient({
        baseUrl: opts.apiUrl,
        apiKey: opts.apiKey,
        sessionToken: opts.sessionToken,
      });
    }

    this.server =
      opts.server ?? (opts.rpcUrl ? new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith('http://') }) : (null as any));
    this.contract = opts.contractId ? new Contract(opts.contractId) : (null as any);
    this.networkPassphrase = opts.networkPassphrase ?? '';
    this.txTimeoutSeconds = opts.txTimeoutSeconds ?? 30;

    if (!opts.skipCompatibilityCheck && this.contract) {
      const sdkVer = opts.sdkVersion ?? '0.1.0';
      this.compatibilityPromise = (async () => {
        try {
          const contractVer = await this.version();
          checkCompatibility(contractVer, sdkVer);
        } catch (err) {
          if (err instanceof CompatibilityError) {
            throw err;
          }
        }
      })();
    } else {
      this.compatibilityPromise = null;
    }
  }

  // ----- Write methods (sign + submit) -----

  async initialize(
    signer: Keypair,
    admin: string,
    surety: string,
    token: string
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'initialize', [
      addressToScVal(admin),
      addressToScVal(surety),
      addressToScVal(token),
    ]);
  }

  async registerImporter(
    signer: Keypair,
    importer: string,
    bondId: bigint,
    requiredCollateral: bigint
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'register_importer', [
      addressToScVal(importer),
      nativeToScVal(bondId, { type: 'u64' }),
      nativeToScVal(requiredCollateral, { type: 'i128' }),
    ]);
  }

  async depositCollateral(
    signer: Keypair,
    importer: string,
    from: string,
    amount: bigint
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'deposit_collateral', [
      addressToScVal(importer),
      addressToScVal(from),
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  async depositReserve(
    signer: Keypair,
    importer: string,
    from: string,
    amount: bigint
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'deposit_reserve', [
      addressToScVal(importer),
      addressToScVal(from),
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  async setRequiredCollateral(
    signers: Keypair[],
    importer: string,
    newRequired: bigint,
    priceOracleContract?: string,
    bypassRateLimit?: boolean,
    emergency?: boolean
  ): Promise<InvokeResult<null>> {
    const primarySigner = signers[0];
    if (!primarySigner) {
      throw new Error('At least one signer is required for setRequiredCollateral');
    }
    const args = [
      addressToScVal(primarySigner.publicKey()),
      addressToScVal(importer),
      nativeToScVal(newRequired, { type: 'i128' }),
    ];

    if (priceOracleContract) {
      args.push(nativeToScVal({ Some: addressToScVal(priceOracleContract) }, { type: 'option' }));
    } else {
      args.push(nativeToScVal(null, { type: 'option' }));
    }

    args.push(nativeToScVal(bypassRateLimit ?? false, { type: 'bool' }));
    args.push(nativeToScVal(emergency ?? false, { type: 'bool' }));

    return this.invokeAndSubmitMulti(signers, 'set_required_collateral', args, primarySigner);
  }

  async autoTopUp(signer: Keypair, importer: string): Promise<InvokeResult<bigint>> {
    return this.invokeAndSubmit(signer, 'auto_top_up', [addressToScVal(importer)]);
  }

  async withdrawCollateral(
    signer: Keypair,
    importer: string,
    to: string,
    amount: bigint
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'withdraw_collateral', [
      addressToScVal(importer),
      addressToScVal(to),
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  async accrueYield(
    signer: Keypair,
    importer: string,
    amount: bigint
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'accrue_yield', [
      addressToScVal(importer),
      nativeToScVal(amount, { type: 'i128' }),
    ]);
  }

  async clawback(signer: Keypair, importer: string): Promise<InvokeResult<bigint>> {
    return this.invokeAndSubmit(signer, 'clawback', [addressToScVal(importer)]);
  }

  /**
   * Transfer the platform admin role to a new address.
   * The current admin (signer) authorizes the handoff on-chain; the new admin
   * becomes effective immediately and an `admin_transferred` event is emitted.
   */
  async transferAdmin(signer: Keypair, newAdmin: string): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'transfer_admin', [addressToScVal(newAdmin)]);
  }

  // #336 — importer formally disputes the most recent oracle-set required_collateral.
  // Must be called within the 72-hour window opened by set_required_collateral.
  async raiseDispute(signer: Keypair, importer: string): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'raise_dispute', [addressToScVal(importer)]);
  }

  // #336 — platform admin resolves an open dispute.
  // accept=true keeps the new oracle value; accept=false reverts to pre-dispute value.
  async resolveDispute(
    signer: Keypair,
    importer: string,
    accept: boolean
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, 'resolve_dispute', [
      addressToScVal(importer),
      nativeToScVal(accept, { type: 'bool' }),
    ]);
  }

  // ----- Read methods (simulate only) -----

  async getAccount(importer: string): Promise<TariffShieldAccount> {
    const raw = await this.simulate('get_account', [addressToScVal(importer)]);
    const obj = scValToNative(raw) as Record<string, unknown>;
    return {
      bondId: BigInt(obj.bond_id as string | number),
      collateralBalance: BigInt(obj.collateral_balance as string),
      requiredCollateral: BigInt(obj.required_collateral as string),
      reserveBalance: BigInt(obj.reserve_balance as string),
      yieldAccrued: BigInt(obj.yield_accrued as string),
      isClawbacked: Boolean(obj.is_clawbacked),
      collateralLastUpdated: BigInt(obj.collateral_last_updated as string | number),
      disputeExpiresAt: BigInt((obj.dispute_expires_at as string | number) ?? 0),
      preDisputeRequired: BigInt((obj.pre_dispute_required as string) ?? 0),
      disputeRaised: Boolean(obj.dispute_raised),
      oracleLastUpdated: BigInt((obj.oracle_last_updated as string | number) ?? 0),
    };
  }

  // #331 — return the rolling on-chain audit trail of required_collateral changes.
  async getCollateralHistory(importer: string): Promise<CollateralHistoryEntry[]> {
    const raw = await this.simulate('get_collateral_history', [addressToScVal(importer)]);
    const arr = scValToNative(raw) as Array<Record<string, unknown>>;
    return arr.map((entry) => ({
      value: BigInt((entry.value as string | number) ?? 0),
      timestamp: BigInt((entry.timestamp as string | number) ?? 0),
    }));
  }

  async getAdmin(): Promise<string> {
    const raw = await this.simulate('get_admin', []);
    return scValToNative(raw) as string;
  }

  async getSurety(): Promise<string> {
    const raw = await this.simulate('get_surety', []);
    return scValToNative(raw) as string;
  }

  async getToken(): Promise<string> {
    const raw = await this.simulate('get_token', []);
    return scValToNative(raw) as string;
  }

  async getOracleSigners(): Promise<string[]> {
    const raw = await this.simulate('get_oracle_signers', []);
    const scArray = scValToNative(raw) as string[];
    return scArray;
  }

  async updateOracleSigners(
    signer: Keypair,
    newSigners: string[],
    approvals: string[]
  ): Promise<InvokeResult<void>> {
    const scNewSigners = nativeToScVal(newSigners.map((s) => new Address(s)));
    const scApprovals = nativeToScVal(approvals.map((s) => new Address(s)));
    return this.invokeAndSubmit(signer, 'update_oracle_signers', [scNewSigners, scApprovals]);
  }

  async version(): Promise<string> {
    const raw = await this.simulate('version', []);
    return scValToNative(raw) as string;
  }


  // ----- Internals -----

  private async simulate(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    if (this.compatibilityPromise && method !== 'version') {
      await this.compatibilityPromise;
    }
    // Use the contract owner address as a stand-in source — read-only simulation does not require this account to exist.
    // Per @stellar/stellar-sdk, build a transaction with a no-op source account loaded from RPC.
    const sourceAccount = await this.server.getAccount(
      'GBEB3ISGEGXFENDBEK6WCHNAJUXL4CMEPMTC3MCJ4A4NQAF6TTLLFPFD'
    );
    const tx = new TransactionBuilder(sourceAccount, {
      fee: DEFAULT_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate ${method} failed: ${sim.error}`);
    }
    if (!sim.result?.retval) {
      throw new Error(`simulate ${method} returned no value`);
    }
    return sim.result.retval;
  }

  private async invokeAndSubmitMulti<T>(
    signers: Keypair[],
    method: string,
    args: xdr.ScVal[],
    primary: Keypair
  ): Promise<InvokeResult<T>> {
    const account = await this.server.getAccount(primary.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: DEFAULT_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.txTimeoutSeconds)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    for (const signer of signers) {
      prepared.sign(signer);
    }
    const sendResponse = await this.server.sendTransaction(prepared);
    if (sendResponse.status === 'ERROR') {
      throw new Error(`send failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }
    const txHash = sendResponse.hash;

    let txResult = await this.server.getTransaction(txHash);
    const deadline = Date.now() + 60_000;
    while (txResult.status === 'NOT_FOUND' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      txResult = await this.server.getTransaction(txHash);
    }
    if (txResult.status !== 'SUCCESS') {
      throw new Error(`tx ${txHash} status=${txResult.status}`);
    }
    const retval = txResult.returnValue;
    const parsed = (retval ? scValToNative(retval) : null) as T;
    return {
      txHash,
      result: parsed,
      ledgerSequence: txResult.ledger,
      applicationOrder: txResult.applicationOrder,
    };
  }

  private async invokeAndSubmit<T>(
    signer: Keypair,
    method: string,
    args: xdr.ScVal[]
  ): Promise<InvokeResult<T>> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: DEFAULT_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.txTimeoutSeconds)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const sendResponse = await this.server.sendTransaction(prepared);
    if (sendResponse.status === 'ERROR') {
      throw new Error(`send failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }
    const txHash = sendResponse.hash;

    let txResult = await this.server.getTransaction(txHash);
    const deadline = Date.now() + 60_000;
    while (txResult.status === 'NOT_FOUND' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      txResult = await this.server.getTransaction(txHash);
    }
    if (txResult.status !== 'SUCCESS') {
      throw new Error(
        `tx ${txHash} status=${txResult.status} (${(txResult as { resultXdr?: { toXDR(format: string): string } }).resultXdr?.toXDR('base64') ?? 'no xdr'})`
      );
    }

    const retval = txResult.returnValue;
    const parsed = (retval ? scValToNative(retval) : null) as T;
    return {
      txHash,
      result: parsed,
      ledgerSequence: txResult.ledger,
      applicationOrder: txResult.applicationOrder,
    };
  }
}

function addressToScVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

export {
  Keypair,
  Networks,
  COMPATIBILITY_MATRIX,
  CompatibilityError,
  checkCompatibility,
  type ContractVersionRange,
};
