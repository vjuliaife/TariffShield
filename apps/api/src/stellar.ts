import { Keypair } from "@stellar/stellar-sdk";
import { TariffShieldClient } from "@tariffshield/sdk";
import client from "prom-client";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { env } from "./config/env.js";
import { createRpcServer } from "./lib/soroban/rpcClient.js";

const tracer = trace.getTracer("tariffshield-stellar");

// #339 — general admin (registration, withdrawals, upgrades)
export const platformKeypair = Keypair.fromSecret(env.PLATFORM_STELLAR_SECRET);
export const suretyKeypair = Keypair.fromSecret(env.SURETY_STELLAR_SECRET);
// #339 — oracle-only role (set_required_collateral); falls back to platformKeypair in dev
export const oracleKeypair = env.ORACLE_STELLAR_SECRET
  ? Keypair.fromSecret(env.ORACLE_STELLAR_SECRET)
  : platformKeypair;

/** Collect all configured admin keypairs for multi-signer oracle updates. */
export function getOracleSignerKeypairs(count: number): Keypair[] {
  const kps: Keypair[] = [platformKeypair];
  if (count >= 2 && env.ADMIN_2_SECRET) kps.push(Keypair.fromSecret(env.ADMIN_2_SECRET));
  if (count >= 3 && env.ADMIN_3_SECRET) kps.push(Keypair.fromSecret(env.ADMIN_3_SECRET));
  return kps;
}

export const sorobanRpcCallsTotal = new client.Counter({
  name: "soroban_rpc_calls_total",
  help: "Total number of Soroban RPC calls made",
  labelNames: ["method", "success"],
});

export const sorobanRpcDurationSeconds = new client.Histogram({
  name: "soroban_rpc_duration_seconds",
  help: "Duration of Soroban RPC calls in seconds",
  labelNames: ["method"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const rpcServer = createRpcServer(env.STELLAR_RPC_URL);

const baseClient = new TariffShieldClient({
  rpcUrl: env.STELLAR_RPC_URL,
  contractId: env.TARIFF_SHIELD_CONTRACT_ID,
  networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
  server: rpcServer,
});

export const contractClient = new Proxy(baseClient, {
  get(target, prop, receiver) {
    const original = Reflect.get(target, prop, receiver);
    if (typeof original === "function") {
      return async (...args: any[]) => {
        const methodName = String(prop);
        return tracer.startActiveSpan(`soroban.rpc.${methodName}`, async (span) => {
          span.setAttributes({
            "soroban.method": methodName,
            "soroban.network": env.STELLAR_NETWORK_PASSPHRASE,
          });
          const start = process.hrtime();
          try {
            const result = await original.apply(target, args);
            const diff = process.hrtime(start);
            const duration = diff[0] + diff[1] / 1e9;
            sorobanRpcCallsTotal.inc({ method: methodName, success: "true" });
            sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            const diff = process.hrtime(start);
            const duration = diff[0] + diff[1] / 1e9;
            sorobanRpcCallsTotal.inc({ method: methodName, success: "false" });
            sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    }
    return original;
  },
});

export const explorerTx = (hash: string): string =>
  `https://stellar.expert/explorer/${env.STELLAR_NETWORK}/tx/${hash}`;

export async function getCurrentLedgerSequence(): Promise<number> {
  const server = createRpcServer(env.STELLAR_RPC_URL);
  const methodName = "getLatestLedger";
  return tracer.startActiveSpan(`soroban.rpc.${methodName}`, async (span) => {
    span.setAttributes({
      "soroban.method": methodName,
      "soroban.network": env.STELLAR_NETWORK_PASSPHRASE,
    });
    const start = process.hrtime();
    try {
      const latest = await server.getLatestLedger();
      const diff = process.hrtime(start);
      const duration = diff[0] + diff[1] / 1e9;
      sorobanRpcCallsTotal.inc({ method: methodName, success: "true" });
      sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
      span.setStatus({ code: SpanStatusCode.OK });
      return latest.sequence;
    } catch (err) {
      const diff = process.hrtime(start);
      const duration = diff[0] + diff[1] / 1e9;
      sorobanRpcCallsTotal.inc({ method: methodName, success: "false" });
      sorobanRpcDurationSeconds.observe({ method: methodName }, duration);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Pings the Soroban RPC server to check if it's reachable.
 */
export async function pingRpc(): Promise<void> {
  const server = createRpcServer(env.STELLAR_RPC_URL);
  await server.getNetwork();
}

/**
 * Retrieves the current collateral balance for a bond directly from the Soroban contract.
 * @param stellarAddress The importer's Stellar address.
 * @returns The on-chain collateral balance as a string.
 */
export async function getBondOnChain(stellarAddress: string): Promise<string> {
  const acct = await contractClient.getAccount(stellarAddress);
  return acct.collateralBalance.toString();
}

/**
 * Retrieves the required_collateral for an importer address from the contract.
 */
export async function getRequiredCollateralOnChain(stellarAddress: string): Promise<string> {
  const acct = await contractClient.getAccount(stellarAddress);
  return acct.requiredCollateral.toString();
}
