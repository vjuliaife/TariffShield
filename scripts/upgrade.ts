import { Command } from "commander";
import { Keypair } from "@stellar/stellar-sdk";
import { env } from "../apps/api/src/config/env.js";
import { contractClient, platformKeypair } from "../apps/api/src/stellar.js";

const program = new Command();

program
  .name("upgrade")
  .description("Multi-sig upgrade tool for TariffShield contract")
  .version("1.0.0");

program
  .command("propose")
  .description("Propose a new wasm hash for upgrade")
  .requiredOption("--hash <hex>", "New wasm hash in hex")
  .action(async (options) => {
    try {
      const hashBuffer = Buffer.from(options.hash, "hex");
      if (hashBuffer.length !== 32) throw new Error("Hash must be 32 bytes");

      console.log(`Submitting proposal from Admin 1...`);
      const result = await contractClient.proposeUpgrade(
        platformKeypair,
        platformKeypair.publicKey(),
        hashBuffer
      );
      
      console.log(`✅ Proposal created! Proposal ID: ${result.result}`);
      console.log(`Tx Hash: ${result.txHash}`);
    } catch (e) {
      console.error("Error proposing upgrade:", e);
    }
  });

program
  .command("approve")
  .description("Approve an existing upgrade proposal")
  .requiredOption("--id <number>", "Proposal ID")
  .requiredOption("--admin <number>", "Which admin is approving (1, 2, or 3)")
  .action(async (options) => {
    try {
      const proposalId = BigInt(options.id);
      let kp: Keypair;
      
      if (options.admin === "1") {
        kp = platformKeypair;
      } else if (options.admin === "2") {
        if (!env.ADMIN_2_SECRET) throw new Error("ADMIN_2_SECRET not set");
        kp = Keypair.fromSecret(env.ADMIN_2_SECRET);
      } else if (options.admin === "3") {
        if (!env.ADMIN_3_SECRET) throw new Error("ADMIN_3_SECRET not set");
        kp = Keypair.fromSecret(env.ADMIN_3_SECRET);
      } else {
        throw new Error("Invalid admin number. Must be 1, 2, or 3");
      }

      console.log(`Approving proposal ${proposalId} from Admin ${options.admin}...`);
      const result = await contractClient.approveUpgrade(
        kp,
        kp.publicKey(),
        proposalId
      );
      
      console.log(`✅ Approved proposal ${proposalId}`);
      console.log(`Tx Hash: ${result.txHash}`);
    } catch (e) {
      console.error("Error approving upgrade:", e);
    }
  });

program.parse();
