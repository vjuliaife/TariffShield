import { Command } from "commander";
import dotenv from "dotenv";

// db.js/stellar.js/auth.js (via config/env.js) read process.env at module load
// time, which happens as soon as they're imported — before commander parses
// --env-file below. Scan argv for it and load the file ourselves first so
// the option actually takes effect (#1141).
const envFileFlagIndex = process.argv.findIndex((arg) => arg === "-e" || arg === "--env-file");
const envFilePath = envFileFlagIndex !== -1 ? process.argv[envFileFlagIndex + 1] : undefined;
dotenv.config(envFilePath ? { path: envFilePath } : undefined);

const { pool } = await import("../apps/api/src/db.js");
const { contractClient, platformKeypair } = await import("../apps/api/src/stellar.js");
const { hashPassword } = await import("../apps/api/src/auth.js");
const { Keypair } = await import("@stellar/stellar-sdk");

const program = new Command();

// #1140 — 7-decimal XLM display helper for the auto-top-up dry-run output.
function xlm(stroops: bigint | string | number): string {
  return `${(Number(BigInt(stroops)) / 1e7).toFixed(2)} XLM`;
}

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
  .command("auto-top-up")
  .description(
    "Compute (dry-run), and with --execute submit, the auto_top_up shortfall move for an importer (#1140)"
  )
  .requiredOption("--importer-id <id>", "Importer UUID")
  .option("--execute", "Submit the real on-chain auto_top_up transaction")
  .action(async (options) => {
    try {
      const importerResult = await pool.query("SELECT * FROM importers WHERE id = $1", [options.importerId]);
      if (importerResult.rowCount === 0) {
        throw new Error("Importer not found");
      }
      const importer = importerResult.rows[0];

      // Required collateral: latest tariff upload (the upload route stores the
      // on-chain required_stroops), falling back to the latest required_changed event.
      const uploads = await pool.query(
        `SELECT computed_required_collateral::text AS req
         FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [importer.id]
      );
      let dbRequired: bigint | null =
        uploads.rowCount && uploads.rowCount > 0 ? BigInt(uploads.rows[0].req) : null;
      if (dbRequired === null) {
        const reqEvents = await pool.query(
          `SELECT amount::text AS req FROM contract_events
           WHERE importer_id = $1 AND kind = 'required_changed' ORDER BY created_at DESC LIMIT 1`,
          [importer.id]
        );
        if (reqEvents.rowCount && reqEvents.rowCount > 0) {
          dbRequired = BigInt(reqEvents.rows[0].req);
        }
      }

      // Deposit/withdraw/top-up history from contract_events (stroops).
      const events = await pool.query(
        `SELECT kind, COALESCE(SUM(amount), 0)::text AS total
         FROM contract_events
         WHERE importer_id = $1 AND kind IN ('deposit_collateral','deposit_reserve','withdraw','auto_top_up')
         GROUP BY kind`,
        [importer.id]
      );
      const totals = new Map<string, bigint>();
      for (const row of events.rows) {
        totals.set(row.kind, BigInt(row.total));
      }
      const sumOf = (...kinds: string[]): bigint =>
        kinds.reduce((acc, k) => acc + (totals.get(k) ?? 0n), 0n);

      // Prefer live on-chain state when the importer is actually registered
      // (seeded demo importers use placeholder addresses, so fall back to the
      // ledger-event picture and label the result as a dry-run).
      let onChain: Awaited<ReturnType<typeof contractClient.getAccount>> | null = null;
      try {
        onChain = await contractClient.getAccount(importer.stellar_address);
      } catch {
        onChain = null;
      }

      const required = onChain ? onChain.requiredCollateral : (dbRequired ?? 0n);
      const collateral = onChain
        ? onChain.collateralBalance
        : sumOf("deposit_collateral") - sumOf("withdraw");
      const reserve = sumOf("deposit_reserve") - sumOf("auto_top_up");

      const shortfall = required > collateral ? required - collateral : 0n;
      const moved = shortfall > 0n && reserve > 0n ? (shortfall < reserve ? shortfall : reserve) : 0n;
      const source = onChain ? "on-chain account" : "DB ledger events (dry-run)";

      console.log(`\🔺 auto_top_up for ${importer.legal_name} (${importer.id})`);
      console.log(`   Source: ${source}`);
      console.log(`   Required collateral: ${xlm(required)}`);
      console.log(`   Collateral balance:  ${xlm(collateral)}`);
      console.log(`   Reserve balance:     ${xlm(reserve)}`);
      if (shortfall === 0n) {
        console.log(`   Shortfall: none — collateral already meets required. Nothing to move.`);
      } else {
        console.log(`   Shortfall: ${xlm(shortfall)}`);
        console.log(`   Would move: ${xlm(moved)} reserve → collateral`);
      }

      if (options.execute) {
        if (!onChain) {
          throw new Error(
            `Importer ${importer.id} is not reachable on-chain (${importer.stellar_address}). ` +
              `Seeded demo addresses are placeholders — register/fund a real on-chain importer first.`
          );
        }
        if (moved === 0n) {
          console.log(`   Nothing to execute — no positive shortfall.`);
          return;
        }
        const result = await contractClient.autoTopUp(platformKeypair, importer.stellar_address);
        await pool.query(
          `INSERT INTO contract_events (importer_id, kind, amount, tx_hash)
           VALUES ($1, 'auto_top_up', $2, $3) ON CONFLICT DO NOTHING`,
          [importer.id, result.result.toString(), result.txHash]
        );
        console.log(`   ✅ Executed on-chain: moved ${xlm(result.result)} (tx ${result.txHash})`);
      } else {
        console.log(`   Dry-run only — re-run with --execute to submit the transaction.`);
      }
    } catch (e) {
      console.error("Error in auto-top-up:", e);
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
