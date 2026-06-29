/**
 * scripts/rotate-admin.ts
 *
 * Zero-downtime admin keypair rotation for the TariffShield Soroban contract.
 *
 * Flow:
 *  1. Load current admin from PLATFORM_STELLAR_SECRET.
 *  2. Generate (or accept via --new-secret) a fresh Stellar keypair.
 *  3. Verify the new keypair is funded (≥ 1 XLM reserve).
 *  4. Build and submit a transfer_admin transaction signed by the current admin.
 *  5. Confirm the on-chain admin address equals the new keypair's public key.
 *  6. Print post-rotation instructions for updating secrets in Render / Vercel,
 *     or call the provider API automatically when RENDER_API_KEY / VERCEL_TOKEN
 *     env vars are present.
 *
 * Flags:
 *   --dry-run       Simulate the transaction and print the XDR; do not broadcast.
 *   --new-secret    Provide an existing secret instead of generating a fresh one.
 *
 * Usage:
 *   npx ts-node scripts/rotate-admin.ts [--dry-run] [--new-secret SXXX...]
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Contract,
  rpc as SorobanRpc,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk";

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseArgs(): { dryRun: boolean; newSecret: string | null } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const nsIdx = args.indexOf("--new-secret");
  const newSecret = nsIdx !== -1 ? (args[nsIdx + 1] ?? null) : null;
  return { dryRun, newSecret };
}

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional_env(key: string): string | null {
  return process.env[key] ?? null;
}

/** Returns the native XLM balance in stroops (1 XLM = 10_000_000 stroops). */
async function getNativeBalance(
  server: SorobanRpc.Server,
  publicKey: string,
): Promise<bigint> {
  try {
    const account = await server.getAccount(publicKey);
    // Horizon account record exposes balances via getLedgerEntries — use getAccount
    // which returns an AccountResponse that includes balances on the real network.
    // For the RPC-only path we use getLedgerEntries for the account entry.
    const balanceStr = (account as unknown as { balances?: Array<{ asset_type: string; balance: string }> })
      .balances
      ?.find((b) => b.asset_type === "native")
      ?.balance;
    if (balanceStr) return BigInt(Math.round(parseFloat(balanceStr) * 10_000_000));
  } catch {
    // getAccount may not expose balances through the Soroban RPC path — fall through.
  }
  return 0n;
}

/** Call transfer_admin on the contract and return the tx hash or XDR (dry-run). */
async function rotateAdmin(opts: {
  server: SorobanRpc.Server;
  contractId: string;
  networkPassphrase: string;
  currentAdmin: Keypair;
  newAdmin: Keypair;
  dryRun: boolean;
}): Promise<string> {
  const { server, contractId, networkPassphrase, currentAdmin, newAdmin, dryRun } = opts;

  const account = await server.getAccount(currentAdmin.publicKey());
  const contract = new Contract(contractId);

  const newAdminScVal = new Address(newAdmin.publicKey()).toScVal();

  const tx = new TransactionBuilder(account, {
    fee: "1000000", // 0.1 XLM — generous for Soroban
    networkPassphrase,
  })
    .addOperation(contract.call("transfer_admin", newAdminScVal))
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);

  if (dryRun) {
    console.log("\n[dry-run] transaction XDR (not broadcast):");
    console.log(prepared.toXDR());
    return prepared.toXDR();
  }

  prepared.sign(currentAdmin);
  const sendResp = await server.sendTransaction(prepared);
  if (sendResp.status === "ERROR") {
    throw new Error(`sendTransaction failed: ${JSON.stringify(sendResp.errorResult)}`);
  }

  const txHash = sendResp.hash;
  console.log(`  tx submitted: ${txHash}`);

  // Poll until confirmed
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(txHash);
    if (result.status === "SUCCESS") return txHash;
    if (result.status !== "NOT_FOUND") {
      throw new Error(`tx ${txHash} failed with status=${result.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`tx ${txHash} timed out after 60s`);
}

/** Read the current on-chain admin address via simulation. */
async function getOnChainAdmin(
  server: SorobanRpc.Server,
  contractId: string,
  networkPassphrase: string,
): Promise<string> {
  const dummySource = await server.getAccount(
    "GBEB3ISGEGXFENDBEK6WCHNAJUXL4CMEPMTC3MCJ4A4NQAF6TTLLFPFD",
  ).catch(() => null);
  if (!dummySource) return "(unknown — could not load source account for simulation)";

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(dummySource, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(contract.call("get_admin"))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`get_admin simulation failed: ${sim.error}`);
  }
  const { scValToNative } = await import("@stellar/stellar-sdk");
  return scValToNative(sim.result!.retval) as string;
}

// ─── provider secret update helpers ──────────────────────────────────────────

async function updateRenderSecret(newSecret: string, serviceName: string): Promise<void> {
  const apiKey = optional_env("RENDER_API_KEY");
  if (!apiKey) return;

  console.log("\n  [Render] RENDER_API_KEY found — attempting automatic secret update…");

  // Find service by name
  const listResp = await fetch(
    `https://api.render.com/v1/services?name=${encodeURIComponent(serviceName)}&limit=1`,
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } },
  );
  if (!listResp.ok) {
    console.warn(`  [Render] Could not list services (${listResp.status}). Update manually.`);
    return;
  }
  const services = (await listResp.json()) as Array<{ service: { id: string; name: string } }>;
  const service = services.find((s) => s.service.name === serviceName)?.service;
  if (!service) {
    console.warn(`  [Render] Service "${serviceName}" not found. Update PLATFORM_STELLAR_SECRET manually.`);
    return;
  }

  const patchResp = await fetch(
    `https://api.render.com/v1/services/${service.id}/env-vars`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify([{ key: "PLATFORM_STELLAR_SECRET", value: newSecret }]),
    },
  );
  if (patchResp.ok) {
    console.log(`  [Render] ✓ PLATFORM_STELLAR_SECRET updated for service "${service.name}".`);
    console.log("  [Render] Trigger a manual deploy for the change to take effect.");
  } else {
    console.warn(`  [Render] Update failed (${patchResp.status}). Update manually.`);
  }
}

async function updateVercelSecret(newSecret: string, projectName: string): Promise<void> {
  const token = optional_env("VERCEL_TOKEN");
  if (!token) return;

  console.log("\n  [Vercel] VERCEL_TOKEN found — attempting automatic secret update…");

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Upsert the env variable across all environments
  const upsertResp = await fetch("https://api.vercel.com/v9/projects/" + projectName + "/env", {
    method: "POST",
    headers,
    body: JSON.stringify({
      key: "PLATFORM_STELLAR_SECRET",
      value: newSecret,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }),
  });

  if (upsertResp.ok || upsertResp.status === 409) {
    if (upsertResp.status === 409) {
      // Variable exists — patch it
      const listResp = await fetch(
        `https://api.vercel.com/v9/projects/${projectName}/env`,
        { headers },
      );
      if (listResp.ok) {
        const { envs } = (await listResp.json()) as { envs: Array<{ id: string; key: string }> };
        const existing = envs.find((e) => e.key === "PLATFORM_STELLAR_SECRET");
        if (existing) {
          const patchResp = await fetch(
            `https://api.vercel.com/v9/projects/${projectName}/env/${existing.id}`,
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({ value: newSecret }),
            },
          );
          if (patchResp.ok) {
            console.log("  [Vercel] ✓ PLATFORM_STELLAR_SECRET updated.");
            return;
          }
        }
      }
      console.warn("  [Vercel] Could not patch existing variable. Update manually.");
    } else {
      console.log("  [Vercel] ✓ PLATFORM_STELLAR_SECRET created.");
    }
  } else {
    console.warn(`  [Vercel] Update failed (${upsertResp.status}). Update manually.`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { dryRun, newSecret: providedNewSecret } = parseArgs();

  // Required env vars
  const currentSecret = require_env("PLATFORM_STELLAR_SECRET");
  const rpcUrl = require_env("STELLAR_RPC_URL");
  const contractId = require_env("CONTRACT_ID");
  const networkPassphrase =
    process.env.STELLAR_NETWORK === "mainnet"
      ? Networks.PUBLIC
      : Networks.TESTNET;

  // Optional — used only for provider API calls
  const renderServiceName = process.env.RENDER_SERVICE_NAME ?? "tariffshield-api";
  const vercelProjectName = process.env.VERCEL_PROJECT_NAME ?? "tariffshield-web";

  const currentAdmin = Keypair.fromSecret(currentSecret);
  const newAdmin = providedNewSecret
    ? Keypair.fromSecret(providedNewSecret)
    : Keypair.random();

  console.log("=== TariffShield Admin Keypair Rotation ===");
  console.log(`  Mode              : ${dryRun ? "DRY RUN (no broadcast)" : "LIVE"}`);
  console.log(`  Network           : ${networkPassphrase === Networks.PUBLIC ? "mainnet" : "testnet"}`);
  console.log(`  Current admin     : ${currentAdmin.publicKey()}`);
  console.log(`  New admin         : ${newAdmin.publicKey()}`);
  console.log(`  Contract          : ${contractId}`);

  const server = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });

  // ── 1. Verify new keypair funding ────────────────────────────────────────
  const MIN_RESERVE_STROOPS = 10_000_000n; // 1 XLM
  console.log("\n[1/4] Checking new admin funding…");
  const balance = await getNativeBalance(server, newAdmin.publicKey());
  if (!dryRun && balance < MIN_RESERVE_STROOPS) {
    throw new Error(
      `New admin ${newAdmin.publicKey()} has insufficient XLM balance: ` +
        `${Number(balance) / 10_000_000} XLM (minimum 1 XLM required). ` +
        `Fund the account before rotating.`,
    );
  }
  if (dryRun) {
    console.log("  [dry-run] Skipping funding check.");
  } else {
    console.log(`  ✓ Balance: ${Number(balance) / 10_000_000} XLM`);
  }

  // ── 2. Submit transfer_admin ─────────────────────────────────────────────
  console.log("\n[2/4] Submitting transfer_admin transaction…");
  const txResult = await rotateAdmin({
    server,
    contractId,
    networkPassphrase,
    currentAdmin,
    newAdmin,
    dryRun,
  });

  if (dryRun) {
    console.log("\n[dry-run] Done. Nothing was broadcast. XDR printed above.");
    return;
  }
  console.log(`  ✓ Confirmed tx: ${txResult}`);

  // ── 3. Verify on-chain admin ─────────────────────────────────────────────
  console.log("\n[3/4] Verifying on-chain admin…");
  const onChainAdmin = await getOnChainAdmin(server, contractId, networkPassphrase);
  if (onChainAdmin !== newAdmin.publicKey()) {
    throw new Error(
      `On-chain admin (${onChainAdmin}) does not match expected new admin (${newAdmin.publicKey()}). ` +
        `Manual investigation required.`,
    );
  }
  console.log(`  ✓ On-chain admin confirmed: ${onChainAdmin}`);

  // ── 4. Update deployment secrets ────────────────────────────────────────
  console.log("\n[4/4] Updating deployment secrets…");

  await updateRenderSecret(newAdmin.secret(), renderServiceName);
  await updateVercelSecret(newAdmin.secret(), vercelProjectName);

  // ── Post-rotation instructions ──────────────────────────────────────────
  console.log(`
============================================================
  ROTATION COMPLETE

  New admin public key  : ${newAdmin.publicKey()}
  New admin secret key  : ${newAdmin.secret()}

  ⚠️  IMPORTANT — update PLATFORM_STELLAR_SECRET in your
      deployment environment to the new secret above, then
      redeploy the API before revoking the old secret.

  Render (manual):
    Dashboard → tariffshield-api → Environment → PLATFORM_STELLAR_SECRET
    Set to: ${newAdmin.secret()}

  Vercel (manual):
    Dashboard → tariffshield-web → Settings → Environment Variables
    Update PLATFORM_STELLAR_SECRET to: ${newAdmin.secret()}

  AWS / other:
    aws ssm put-parameter \\
      --name /tariffshield/PLATFORM_STELLAR_SECRET \\
      --value "${newAdmin.secret()}" \\
      --type SecureString --overwrite

  After deployment, revoke the old secret:
    Old public key: ${currentAdmin.publicKey()}
============================================================
`);
}

main().catch((err) => {
  console.error("\n✗ Rotation failed:", err.message ?? err);
  process.exit(1);
});
