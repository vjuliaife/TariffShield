import pino from "pino";
import { pool } from "../db.js";

const logger = pino({ name: "aml-screening" });

export type AmlRiskScore = "LOW" | "MEDIUM" | "HIGH";

export type AmlScreeningResult = {
  walletAddress: string;
  riskScore: AmlRiskScore;
  providerResponse: Record<string, unknown>;
  resolutionAction: string | null;
};

export async function screenWalletAddress(walletAddress: string): Promise<AmlScreeningResult> {
  logger.info({ walletAddress }, "Screening wallet address against AML provider");
  
  // In a real application, this would call Chainalysis KYT, Elliptic, TRM Labs, etc.
  // For demonstration, we will deterministically score based on the address string
  
  const riskScore: AmlRiskScore = determineMockRiskScore(walletAddress);
  const providerResponse = { mockProvider: "ChainalysisMock", score: riskScore, screenedAt: new Date().toISOString() };
  let resolutionAction: string | null = null;
  
  if (riskScore === "HIGH") {
    resolutionAction = "pending_manual_review";
  } else if (riskScore === "MEDIUM") {
    resolutionAction = "auto_cleared_medium";
  } else {
    resolutionAction = "auto_cleared_low";
  }

  // Record screening to database per BSA requirements
  await pool.query(
    "INSERT INTO aml_screenings (wallet_address, risk_score, provider_response, resolution_action) VALUES ($1, $2, $3, $4)",
    [walletAddress, riskScore, JSON.stringify(providerResponse), resolutionAction]
  );

  return {
    walletAddress,
    riskScore,
    providerResponse,
    resolutionAction,
  };
}

export async function screenImporterEntity(legalName: string, ein?: string): Promise<boolean> {
  // Screen OFAC SDN list for importer legal names and EINs via a sanctions screening API
  // Mock logic: block any name with 'sanctioned'
  logger.info({ legalName, ein }, "Screening importer entity against OFAC");
  
  if (legalName.toLowerCase().includes("sanctioned")) {
    return false;
  }
  return true;
}

function determineMockRiskScore(address: string): AmlRiskScore {
  if (address.startsWith("G") && address.includes("HIGH")) return "HIGH";
  if (address.startsWith("G") && address.includes("MED")) return "MEDIUM";
  return "LOW";
}
