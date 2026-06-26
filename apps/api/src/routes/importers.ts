import { Router, type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import { pool } from "../db.js";
import { authMiddleware, type AuthedRequest } from "../auth.js";
import { contractClient, explorerTx, platformKeypair, suretyKeypair } from "../stellar.js";
import { lookupCbpDutyRate } from "../services/cbp-duty-lookup.js";
import { screenImporterEntity, screenWalletAddress } from "../services/aml-screening.js";
import { env } from "../config/env.js";

export const importersRouter = Router();
importersRouter.use(authMiddleware);

const CreateImporterSchema = z.object({
  legalName: z.string().min(1),
  ein: z.string().optional(),
  bondId: z.coerce.number().int().positive(),
  initialRequiredCollateral: z.string().regex(/^\d+$/),
});

importersRouter.post("/", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "importer") {
    res.status(403).json({ error: "only importer accounts can register" });
    return;
  }

  const parse = CreateImporterSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { legalName, ein, bondId, initialRequiredCollateral } = parse.data;

  const ofacClear = await screenImporterEntity(legalName, ein);
  if (!ofacClear) {
    res.status(403).json({ error: "Importer failed OFAC sanctions screening" });
    return;
  }

  const existing = await pool.query("SELECT id FROM importers WHERE user_id = $1", [user.id]);
  if (existing.rowCount && existing.rowCount > 0) {
    res.status(409).json({ error: "importer already registered for this user" });
    return;
  }

  const kp = Keypair.random();

  const amlRes = await screenWalletAddress(kp.publicKey());
  if (amlRes.riskScore === "HIGH") {
    res.status(403).json({ error: "Wallet address flagged as high risk by AML provider" });
    return;
  }

  const inserted = await pool.query(
    `INSERT INTO importers (user_id, legal_name, ein, bond_id, stellar_address, stellar_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, legal_name, ein, bond_id, stellar_address, created_at`,
    [user.id, legalName, ein ?? null, bondId, kp.publicKey(), kp.secret()],
  );
  const importer = inserted.rows[0]!;

  // Fund the importer account via friendbot (testnet only)
  try {
    const friendbotRes = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
    if (!friendbotRes.ok) throw new Error(`friendbot ${friendbotRes.status}`);
  } catch (err) {
    console.error("[importers] friendbot fund failed:", err);
  }

  // Register importer on-chain. Platform admin signs.
  const onChain = await contractClient.registerImporter(
    platformKeypair,
    kp.publicKey(),
    BigInt(bondId),
    BigInt(initialRequiredCollateral),
  );

  await pool.query("UPDATE importers SET registered_on_chain_tx = $1 WHERE id = $2", [
    onChain.txHash,
    importer.id,
  ]);
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, tx_hash) VALUES ($1, $2, $3)",
    [importer.id, "register", onChain.txHash],
  );

  res.json({
    importer: {
      id: importer.id,
      legalName: importer.legal_name,
      ein: importer.ein,
      bondId: importer.bond_id,
      stellarAddress: importer.stellar_address,
      stellarSecret: kp.secret(),
      registeredOnChainTx: onChain.txHash,
      stellarTxUrl: explorerTx(onChain.txHash),
      createdAt: importer.created_at,
    },
  });
});

importersRouter.get("/", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  let r;
  if (user.role === "surety_admin") {
    r = await pool.query(
      `SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at, u.email
         FROM importers i JOIN users u ON u.id = i.user_id
         ORDER BY i.created_at DESC`,
    );
  } else {
    r = await pool.query(
      `SELECT i.id, i.legal_name, i.bond_id, i.stellar_address, i.created_at
         FROM importers i WHERE i.user_id = $1`,
      [user.id],
    );
  }
  res.json({ importers: r.rows });
});

async function loadImporterFor(req: Request, importerId: string) {
  const user = (req as AuthedRequest).user;
  if (user.role === "surety_admin") {
    const r = await pool.query("SELECT * FROM importers WHERE id = $1", [importerId]);
    return r.rows[0] ?? null;
  }
  const r = await pool.query("SELECT * FROM importers WHERE id = $1 AND user_id = $2", [
    importerId,
    user.id,
  ]);
  return r.rows[0] ?? null;
}

importersRouter.get("/:id", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const acct = await contractClient.getAccount(importer.stellar_address);
  const events = await pool.query(
    "SELECT id, kind, amount, tx_hash, created_at FROM contract_events WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 50",
    [importer.id],
  );
  res.json({
    importer: {
      id: importer.id,
      legalName: importer.legal_name,
      ein: importer.ein,
      bondId: importer.bond_id,
      stellarAddress: importer.stellar_address,
      registeredOnChainTx: importer.registered_on_chain_tx,
      createdAt: importer.created_at,
    },
    onChainAccount: {
      bondId: acct.bondId.toString(),
      collateralBalance: acct.collateralBalance.toString(),
      requiredCollateral: acct.requiredCollateral.toString(),
      reserveBalance: acct.reserveBalance.toString(),
      yieldAccrued: acct.yieldAccrued.toString(),
      isClawbacked: acct.isClawbacked,
    },
    events: events.rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      amount: e.amount,
      txHash: e.tx_hash,
      txUrl: e.tx_hash ? explorerTx(e.tx_hash) : null,
      createdAt: e.created_at,
    })),
  });
});

importersRouter.get("/:id/collateral-status", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const acct = await contractClient.getAccount(importer.stellar_address);
  const lastUpdatedSeconds = Number(acct.collateralLastUpdated);
  const expiresAtSeconds = lastUpdatedSeconds + 365 * 86400;
  const stale = Math.floor(Date.now() / 1000) > expiresAtSeconds;
  res.json({
    stale,
    lastUpdated: new Date(lastUpdatedSeconds * 1000).toISOString(),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  });
});


// --- Synthetic CBP tariff CSV upload — recomputes required_collateral on-chain ---

const TariffLineItemSchema = z.object({
  htsCode: z.string(),
  value: z.coerce.number().positive(),
  dutyRate: z.coerce.number().min(0),
});

const TariffUploadSchema = z.object({
  filename: z.string().optional(),
  lineItems: z.array(TariffLineItemSchema),
});

importersRouter.post("/:id/upload-tariff-csv", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parse = TariffUploadSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }

  let annualDutyTotal = 0;
  const validationReport = [];
  let hasBlockError = false;

  for (const item of parse.data.lineItems) {
    const cbpRes = await lookupCbpDutyRate(item.htsCode);
    const cbpRate = cbpRes.dutyRate ?? item.dutyRate;
    
    const deviation = Math.abs(cbpRate - item.dutyRate);
    if (cbpRate > 0 && deviation / cbpRate > 0.10) {
      validationReport.push({
        htsCode: item.htsCode,
        reportedRate: item.dutyRate,
        cbpRate: cbpRate,
        deviation,
      });
      if (env.CBP_VALIDATION_MODE !== "warn") {
        hasBlockError = true;
      }
    }
    annualDutyTotal += item.value * item.dutyRate;
  }

  if (hasBlockError) {
    res.status(422).json({ error: "CBP validation failed", report: validationReport });
    return;
  }

  // CBP rule of thumb: continuous bond face value ~= 10% of annual duties+taxes+fees.
  // We require importer to collateralize 50% of bond face value (industry-typical cash collateral demand for new importers).
  const bondFaceValue = annualDutyTotal * 0.1;
  const requiredCollateralUSD = bondFaceValue * 0.5;
  // Token is XLM in the demo (1 USD ≈ 1 XLM for stand-in); 7 decimals.
  const requiredStroops = BigInt(Math.round(requiredCollateralUSD * 1e7));

  const onChain = await contractClient.setRequiredCollateral(
    platformKeypair,
    importer.stellar_address,
    requiredStroops,
  );
  await pool.query(
    "INSERT INTO tariff_uploads (importer_id, filename, annual_duty_total, computed_required_collateral, applied_tx) VALUES ($1, $2, $3, $4, $5)",
    [importer.id, parse.data.filename ?? null, annualDutyTotal, requiredStroops.toString(), onChain.txHash],
  );
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'required_changed', $2, $3)",
    [importer.id, requiredStroops.toString(), onChain.txHash],
  );

  res.json({
    annualDutyTotal,
    bondFaceValue,
    requiredCollateralStroops: requiredStroops.toString(),
    txHash: onChain.txHash,
    txUrl: explorerTx(onChain.txHash),
  });
});

const DepositSchema = z.object({
  amountStroops: z.string().regex(/^\d+$/),
  bucket: z.enum(["collateral", "reserve"]),
});

importersRouter.post("/:id/deposit", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parse = DepositSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input" });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === "HIGH") {
    res.status(403).json({ error: "Transaction blocked pending AML review" });
    return;
  }

  const amount = BigInt(parse.data.amountStroops);
  const importerKp = Keypair.fromSecret(importer.stellar_secret_encrypted);

  const fn =
    parse.data.bucket === "collateral"
      ? contractClient.depositCollateral.bind(contractClient)
      : contractClient.depositReserve.bind(contractClient);

  const onChain = await fn(importerKp, importer.stellar_address, importer.stellar_address, amount);
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, $2, $3, $4)",
    [importer.id, parse.data.bucket === "collateral" ? "deposit_collateral" : "deposit_reserve", amount.toString(), onChain.txHash],
  );
  res.json({ txHash: onChain.txHash, txUrl: explorerTx(onChain.txHash) });
});

importersRouter.post("/:id/auto-top-up", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const onChain = await contractClient.autoTopUp(platformKeypair, importer.stellar_address);
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'auto_top_up', $2, $3)",
    [importer.id, onChain.result.toString(), onChain.txHash],
  );
  res.json({
    movedStroops: onChain.result.toString(),
    txHash: onChain.txHash,
    txUrl: explorerTx(onChain.txHash),
  });
});

const WithdrawSchema = z.object({
  amountStroops: z.string().regex(/^\d+$/),
});

importersRouter.post("/:id/withdraw", async (req: Request, res: Response) => {
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parse = WithdrawSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input" });
    return;
  }

  const amlRes = await screenWalletAddress(importer.stellar_address);
  if (amlRes.riskScore === "HIGH") {
    res.status(403).json({ error: "Transaction blocked pending AML review" });
    return;
  }

  const importerKp = Keypair.fromSecret(importer.stellar_secret_encrypted);
  const onChain = await contractClient.withdrawCollateral(
    importerKp,
    importer.stellar_address,
    importer.stellar_address,
    BigInt(parse.data.amountStroops),
  );
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'withdraw', $2, $3)",
    [importer.id, parse.data.amountStroops, onChain.txHash],
  );
  res.json({ txHash: onChain.txHash, txUrl: explorerTx(onChain.txHash) });
});

// --- Surety admin actions ---

const YieldSchema = z.object({ amountStroops: z.string().regex(/^\d+$/) });

importersRouter.post("/:id/accrue-yield", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const parse = YieldSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input" });
    return;
  }
  const onChain = await contractClient.accrueYield(
    platformKeypair,
    importer.stellar_address,
    BigInt(parse.data.amountStroops),
  );
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'yield', $2, $3)",
    [importer.id, parse.data.amountStroops, onChain.txHash],
  );
  res.json({ txHash: onChain.txHash, txUrl: explorerTx(onChain.txHash) });
});

importersRouter.post("/:id/clawback", async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== "surety_admin") {
    res.status(403).json({ error: "surety admin only" });
    return;
  }
  const importer = await loadImporterFor(req, String(req.params.id ?? ""));
  if (!importer) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const onChain = await contractClient.clawback(suretyKeypair, importer.stellar_address);
  await pool.query(
    "INSERT INTO contract_events (importer_id, kind, amount, tx_hash) VALUES ($1, 'clawback', $2, $3)",
    [importer.id, onChain.result.toString(), onChain.txHash],
  );
  res.json({
    clawedStroops: onChain.result.toString(),
    txHash: onChain.txHash,
    txUrl: explorerTx(onChain.txHash),
  });
});
