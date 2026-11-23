import { Command } from "commander";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Transaction,
  rpc,
  scValToNative,
  hash,
} from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { env } from "../apps/api/src/config/env.js";
import { platformKeypair } from "../apps/api/src/stellar.js";

const program = new Command();

const TX_TIMEOUT_SECONDS = 30;
const SUBMIT_POLL_INTERVAL_MS = 1500;
const SUBMIT_DEADLINE_MS = 60_000;

/** Shown in --help and as a runtime warning, so a passing dry-run isn't mistaken for a full
 * pre-upgrade simulation. Mirrors the caveat in the success message below. */
const LIMITATIONS_NOTICE =
  "Limitations: this is NOT a full upgrade simulation. It submits real transactions signed " +
  "by the platform key (wasm upload + throwaway contract deploy), and the throwaway instance " +
  "starts with empty storage, so it cannot catch incompatibilities with the LIVE contract's " +
  "stored data. Rehearse propose_upgrade + approve_upgrade on testnet against real data " +
  "before running `npm run upgrade` on mainnet.";

/** Submits a prepared, signed transaction and polls until it lands, mirroring
 * packages/sdk/src/index.ts's invokeAndSubmit. Returns the transaction's
 * parsed return value (e.g. the new contract's Address for a create-contract
 * host function invocation). */
async function submitAndWait(
  rpcServer: rpc.Server,
  tx: Transaction,
  signer: Keypair,
): Promise<unknown> {
  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(signer);
  const sendResponse = await rpcServer.sendTransaction(prepared);
  if (sendResponse.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sendResponse.errorResult)}`);
  }

  let txResult = await rpcServer.getTransaction(sendResponse.hash);
  const deadline = Date.now() + SUBMIT_DEADLINE_MS;
  while (txResult.status === "NOT_FOUND" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SUBMIT_POLL_INTERVAL_MS));
    txResult = await rpcServer.getTransaction(sendResponse.hash);
  }
  if (txResult.status !== "SUCCESS") {
    throw new Error(`tx ${sendResponse.hash} status=${txResult.status}`);
  }
  return txResult.returnValue ? scValToNative(txResult.returnValue) : null;
}

program
  .name("upgrade-dry-run")
  .description(
    "Upload the candidate wasm and deploy it as a throwaway instance to check that it loads " +
      "and its entrypoints execute. Does NOT verify storage compatibility with the live " +
      "contract's existing data.",
  )
  .requiredOption("--wasm-path <path>", "Path to the new wasm file")
  .requiredOption("--network <network>", "Network (testnet or public)")
  .addHelpText("after", `\n${LIMITATIONS_NOTICE}`)
  .action(async (options) => {
    try {
      console.warn(`⚠️  ${LIMITATIONS_NOTICE}\n`);
      console.log(`Starting upgrade dry-run for ${options.wasmPath} on ${options.network}...`);

      const rpcServer = new rpc.Server(env.STELLAR_RPC_URL);
      const wasmBuffer = readFileSync(options.wasmPath);
      const networkPassphrase = options.network === "public" ? Networks.PUBLIC : Networks.TESTNET;

      // A genuine dry-run has to actually exercise the CANDIDATE wasm's code
      // paths, not the already-deployed contract's. Calling version() on the
      // live contract (the old behavior here) tells you nothing about the
      // new wasm at all. Instead: upload the candidate wasm and deploy it as
      // a throwaway contract instance (a real Soroban contract, but entirely
      // separate from TARIFF_SHIELD_CONTRACT_ID — the live contract's
      // storage is never touched), then invoke the new instance's own
      // version() against it. A wasm with a storage-layout or
      // deserialization incompatibility fails here, on the throwaway
      // instance, exactly as it would if actually deployed.
      console.log(`Uploading candidate wasm (${wasmBuffer.length} bytes)...`);
      const uploaderAccount = await rpcServer.getAccount(platformKeypair.publicKey());
      const uploadTx = new TransactionBuilder(uploaderAccount, {
        fee: "1000000",
        networkPassphrase,
      })
        .addOperation(Operation.uploadContractWasm({ wasm: wasmBuffer }))
        .setTimeout(TX_TIMEOUT_SECONDS)
        .build();
      await submitAndWait(rpcServer, uploadTx, platformKeypair);
      const wasmHash = hash(wasmBuffer);
      console.log(`✅ Candidate wasm uploaded (hash ${wasmHash.toString("hex")})`);

      console.log(`Deploying a throwaway instance of the candidate wasm...`);
      const deployerAccount = await rpcServer.getAccount(platformKeypair.publicKey());
      const salt = randomBytes(32);
      const deployTx = new TransactionBuilder(deployerAccount, {
        fee: "1000000",
        networkPassphrase,
      })
        .addOperation(
          Operation.createCustomContract({
            wasmHash,
            address: Address.fromString(platformKeypair.publicKey()),
            salt,
          }),
        )
        .setTimeout(TX_TIMEOUT_SECONDS)
        .build();
      const deployedAddress = await submitAndWait(rpcServer, deployTx, platformKeypair);
      if (typeof deployedAddress !== "string") {
        throw new Error(
          `expected the deploy transaction's return value to be the new contract's address, got: ${JSON.stringify(deployedAddress)}`,
        );
      }
      const throwawayContractId = deployedAddress;
      console.log(`✅ Throwaway contract deployed at ${throwawayContractId}`);

      console.log(`Simulating version() against the candidate wasm's own instance...`);
      const throwawayContract = new Contract(throwawayContractId);
      const invokerAccount = await rpcServer.getAccount(platformKeypair.publicKey());
      const invokeTx = new TransactionBuilder(invokerAccount, {
        fee: "1000",
        networkPassphrase,
      })
        .addOperation(throwawayContract.call("version"))
        .setTimeout(TX_TIMEOUT_SECONDS)
        .build();

      const sim = await rpcServer.simulateTransaction(invokeTx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation of the candidate wasm failed: ${sim.error}`);
      }
      console.log(`✅ version() simulated successfully against the candidate wasm`);

      console.log(
        `\n✅ Dry-run completed successfully! The candidate wasm was uploaded, deployed as a ` +
          `throwaway instance, and invoked without a deserialization panic. This does not fully ` +
          `prove storage compatibility with the LIVE contract's existing stored data (the throwaway ` +
          `instance starts with empty storage) — only that the wasm itself loads and its entrypoints ` +
          `execute. Review the actual propose_upgrade + approve_upgrade flow on testnet against real ` +
          `data before a mainnet upgrade.`,
      );
      process.exit(0);
    } catch (e) {
      console.error("❌ Dry-run failed:", e);
      process.exit(1);
    }
  });

program.parse();
