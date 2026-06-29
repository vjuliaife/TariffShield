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
} from "@stellar/stellar-sdk";

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
}

export interface TariffShieldClientOptions {
  rpcUrl: string;
  contractId: string;
  networkPassphrase: string;
  /** Optional: allow tests to override the timeout. */
  txTimeoutSeconds?: number;
  /** Optional: custom rpc.Server instance */
  server?: rpc.Server;
}

const DEFAULT_FEE = "1000000"; // 0.1 XLM — generous for Soroban invocations

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

  constructor(opts: TariffShieldClientOptions) {
    this.server = opts.server ?? new rpc.Server(opts.rpcUrl, { allowHttp: opts.rpcUrl.startsWith("http://") });
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase;
    this.txTimeoutSeconds = opts.txTimeoutSeconds ?? 30;
  }

  // ----- Write methods (sign + submit) -----

  async initialize(signer: Keypair, admin: string, surety: string, token: string): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "initialize", [
      addressToScVal(admin),
      addressToScVal(surety),
      addressToScVal(token),
    ]);
  }

  async registerImporter(
    signer: Keypair,
    importer: string,
    bondId: bigint,
    requiredCollateral: bigint,
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "register_importer", [
      addressToScVal(importer),
      nativeToScVal(bondId, { type: "u64" }),
      nativeToScVal(requiredCollateral, { type: "i128" }),
    ]);
  }

  async depositCollateral(
    signer: Keypair,
    importer: string,
    from: string,
    amount: bigint,
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "deposit_collateral", [
      addressToScVal(importer),
      addressToScVal(from),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  async depositReserve(
    signer: Keypair,
    importer: string,
    from: string,
    amount: bigint,
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "deposit_reserve", [
      addressToScVal(importer),
      addressToScVal(from),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  async setRequiredCollateral(
    signers: Keypair[],
    importer: string,
    newRequired: bigint,
    priceOracleContract?: string,
    bypassRateLimit?: boolean,
    emergency?: boolean,
  ): Promise<InvokeResult<null>> {
    const args = [
      addressToScVal(signer.publicKey()),
      addressToScVal(importer),
      nativeToScVal(newRequired, { type: "i128" }),
    ];

    if (priceOracleContract) {
      args.push(nativeToScVal({ Some: addressToScVal(priceOracleContract) }, { type: "option" }));
    } else {
      args.push(nativeToScVal(null, { type: "option" }));
    }

    args.push(nativeToScVal(bypassRateLimit ?? false, { type: "bool" }));
    args.push(nativeToScVal(emergency ?? false, { type: "bool" }));

    return this.invokeAndSubmit(signer, "set_required_collateral", args);
  }

  async autoTopUp(signer: Keypair, importer: string): Promise<InvokeResult<bigint>> {
    return this.invokeAndSubmit(signer, "auto_top_up", [addressToScVal(importer)]);
  }

  async withdrawCollateral(
    signer: Keypair,
    importer: string,
    to: string,
    amount: bigint,
  ): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "withdraw_collateral", [
      addressToScVal(importer),
      addressToScVal(to),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  async accrueYield(signer: Keypair, importer: string, amount: bigint): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "accrue_yield", [
      addressToScVal(importer),
      nativeToScVal(amount, { type: "i128" }),
    ]);
  }

  async clawback(signer: Keypair, importer: string): Promise<InvokeResult<bigint>> {
    return this.invokeAndSubmit(signer, "clawback", [addressToScVal(importer)]);
  }

  // #336 — importer formally disputes the most recent oracle-set required_collateral.
  // Must be called within the 72-hour window opened by set_required_collateral.
  async raiseDispute(signer: Keypair, importer: string): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "raise_dispute", [addressToScVal(importer)]);
  }

  // #336 — platform admin resolves an open dispute.
  // accept=true keeps the new oracle value; accept=false reverts to pre-dispute value.
  async resolveDispute(signer: Keypair, importer: string, accept: boolean): Promise<InvokeResult<null>> {
    return this.invokeAndSubmit(signer, "resolve_dispute", [
      addressToScVal(importer),
      nativeToScVal(accept, { type: "bool" }),
    ]);
  }

  // ----- Read methods (simulate only) -----

  async getAccount(importer: string): Promise<TariffShieldAccount> {
    const raw = await this.simulate("get_account", [addressToScVal(importer)]);
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
    const raw = await this.simulate("get_collateral_history", [addressToScVal(importer)]);
    const arr = scValToNative(raw) as Array<Record<string, unknown>>;
    return arr.map((entry) => ({
      value: BigInt((entry.value as string | number) ?? 0),
      timestamp: BigInt((entry.timestamp as string | number) ?? 0),
    }));
  }

  async getAdmin(): Promise<string> {
    const raw = await this.simulate("get_admin", []);
    return scValToNative(raw) as string;
  }

  async getSurety(): Promise<string> {
    const raw = await this.simulate("get_surety", []);
    return scValToNative(raw) as string;
  }

  async getToken(): Promise<string> {
    const raw = await this.simulate("get_token", []);
    return scValToNative(raw) as string;
  }

  // ----- Internals -----

  private async simulate(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    // Use the contract owner address as a stand-in source — read-only simulation does not require this account to exist.
    // Per @stellar/stellar-sdk, build a transaction with a no-op source account loaded from RPC.
    const sourceAccount = await this.server.getAccount(
      "GBEB3ISGEGXFENDBEK6WCHNAJUXL4CMEPMTC3MCJ4A4NQAF6TTLLFPFD",
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
    primary: Keypair,
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
    if (sendResponse.status === "ERROR") {
      throw new Error(`send failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }
    const txHash = sendResponse.hash;

    let txResult = await this.server.getTransaction(txHash);
    const deadline = Date.now() + 60_000;
    while (txResult.status === "NOT_FOUND" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      txResult = await this.server.getTransaction(txHash);
    }
    if (txResult.status !== "SUCCESS") {
      throw new Error(`tx ${txHash} status=${txResult.status}`);
    }
    const retval = txResult.returnValue;
    const parsed = (retval ? scValToNative(retval) : null) as T;
    return { txHash, result: parsed };
  }

  private async invokeAndSubmit<T>(
    signer: Keypair,
    method: string,
    args: xdr.ScVal[],
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
    if (sendResponse.status === "ERROR") {
      throw new Error(`send failed: ${JSON.stringify(sendResponse.errorResult)}`);
    }
    const txHash = sendResponse.hash;

    let txResult = await this.server.getTransaction(txHash);
    const deadline = Date.now() + 60_000;
    while (txResult.status === "NOT_FOUND" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      txResult = await this.server.getTransaction(txHash);
    }
    if (txResult.status !== "SUCCESS") {
      throw new Error(
        `tx ${txHash} status=${txResult.status} (${(txResult as { resultXdr?: { toXDR(format: string): string } }).resultXdr?.toXDR("base64") ?? "no xdr"})`,
      );
    }

    const retval = txResult.returnValue;
    const parsed = (retval ? scValToNative(retval) : null) as T;
    return { txHash, result: parsed };
  }
}

function addressToScVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

export { Keypair, Networks };
