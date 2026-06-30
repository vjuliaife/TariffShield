import { Router } from "express";
import { ping } from "../db.js";
import { pingRpc } from "../stellar.js";
import { env, isProduction } from "../config/env.js";
import { readFileSync } from "fs";
import { join } from "path";

export const healthRouter = Router();

let version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  version = pkg.version || "unknown";
} catch (e) {}

healthRouter.get("/", async (_req, res) => {
  const checks = {
    db: "connected",
    soroban: "ok",
  };
  let hasError = false;

  try {
    await ping();
  } catch (err) {
    checks.db = "failed";
    hasError = true;
  }

  try {
    await pingRpc();
  } catch (err) {
    checks.soroban = "failed";
    hasError = true;
  }

  if (hasError) {
    res.status(503).json({
      status: "degraded",
      version,
      ...checks,
    });
  } else {
    res.json({
      status: "ok",
      version,
      ...checks,
      contractId: env.TARIFF_SHIELD_CONTRACT_ID,
      network: env.STELLAR_NETWORK,
      env: isProduction ? "production" : "development",
    });
  }
});

healthRouter.get("/live", (_req, res) => {
  res.status(200).send("OK");
});

healthRouter.get("/ready", async (_req, res) => {
  try {
    await Promise.all([ping(), pingRpc()]);
    res.status(200).send("OK");
  } catch (err) {
    res.status(503).send("Service Unavailable");
  }
});
