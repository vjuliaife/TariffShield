import { Command } from "commander";
import { pool } from "../apps/api/src/db.js";
import { contractClient, platformKeypair } from "../apps/api/src/stellar.js";
import { hashPassword } from "../apps/api/src/auth.js";
import { Keypair } from "@stellar/stellar-sdk";

const program = new Command();

program
  .name("admin")
  .description("CLI to manage TariffShield platform operations")
  .version("1.0.0")
  .option("-e, --env-file <path>", "Path to .env file");

program
  .command("register-importer")
  .description("Create an importer account")
  .requiredOption("--email <email>", "Importer's email address")
  .requiredOption("--company <name>", "Company legal name")
  .option("--ein <ein>", "Employer Identification Number")
  .action(async (options) => {
    try {
      const password = Math.random().toString(36).slice(-10);
      const hash = await hashPassword(password);
      
      const userResult = await pool.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
        [options.email.toLowerCase(), hash, "importer"]
      );
      const userId = userResult.rows[0].id;
      
      const kp = Keypair.random();
      const bondId = Math.floor(Math.random() * 1000000);
      const initialRequired = 0n;

      const inserted = await pool.query(
        `INSERT INTO importers (user_id, legal_name, ein, bond_id, stellar_address, stellar_secret_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [userId, options.company, options.ein ?? null, bondId, kp.publicKey(), kp.secret()]
      );
      const importerId = inserted.rows[0].id;

      try {
        await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
      } catch (err) {}

      const onChain = await contractClient.registerImporter(
        platformKeypair,
        kp.publicKey(),
        BigInt(bondId),
        initialRequired
      );

      await pool.query("UPDATE importers SET registered_on_chain_tx = $1 WHERE id = $2", [
        onChain.txHash,
        importerId,
      ]);
      await pool.query(
        "INSERT INTO contract_events (importer_id, kind, tx_hash) VALUES ($1, $2, $3)",
        [importerId, "register", onChain.txHash]
      );

      console.log(`✅ Importer registered successfully!`);
      console.log(`User ID: ${userId}`);
      console.log(`Importer ID: ${importerId}`);
      console.log(`Temporary Password: ${password}`);
    } catch (e) {
      console.error("Error registering importer:", e);
    } finally {
      await pool.end();
    }
  });

program
  .command("set-required")
  .description("Update the bond requirement for an importer")
  .requiredOption("--importer-id <id>", "Importer UUID")
  .requiredOption("--amount <usdc>", "Amount in USDC")
  .action(async (options) => {
    try {
      const importerResult = await pool.query("SELECT * FROM importers WHERE id = $1", [options.importerId]);
      if (importerResult.rowCount === 0) {
        throw new Error("Importer not found");
      }
      const importer = importerResult.rows[0];

      // Convert USDC to stroops (7 decimals for Stellar)
      const amountStroops = BigInt(Math.round(parseFloat(options.amount) * 1e7));

      const onChain = await contractClient.setRequiredCollateral(
        platformKeypair,
        importer.stellar_address,
        amountStroops
      );

      await pool.query(
        "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'required_changed', $2, $3)",
        [importer.id, amountStroops.toString(), onChain.txHash]
      );

      console.log(`✅ Required collateral set to ${options.amount} USDC for ${importer.legal_name}`);
      console.log(`Tx Hash: ${onChain.txHash}`);
    } catch (e) {
      console.error("Error setting required collateral:", e);
    } finally {
      await pool.end();
    }
  });

program
  .command("accrue-yield")
  .description("Manually trigger yield accrual")
  .requiredOption("--importer-id <id>", "Importer UUID")
  .requiredOption("--rate <bps>", "Yield rate in basis points (e.g. 500 for 5%)")
  .action(async (options) => {
    try {
      const importerResult = await pool.query("SELECT * FROM importers WHERE id = $1", [options.importerId]);
      if (importerResult.rowCount === 0) {
        throw new Error("Importer not found");
      }
      const importer = importerResult.rows[0];

      // Fetch on-chain balance to calculate yield amount
      const acct = await contractClient.getAccount(importer.stellar_address);
      const balance = acct.collateralBalance;
      
      const rate = BigInt(options.rate);
      const amountStroops = (balance * rate) / 10000n; // bps

      const onChain = await contractClient.accrueYield(
        platformKeypair,
        importer.stellar_address,
        amountStroops
      );

      await pool.query(
        "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'yield', $2, $3)",
        [importer.id, amountStroops.toString(), onChain.txHash]
      );

      console.log(`✅ Yield accrued for ${importer.legal_name}: ${amountStroops.toString()} stroops`);
      console.log(`Tx Hash: ${onChain.txHash}`);
    } catch (e) {
      console.error("Error accruing yield:", e);
    } finally {
      await pool.end();
    }
  });

program.parse();
