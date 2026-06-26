import "dotenv/config";
import { z } from "zod";

export const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3002).describe("Port for the API server to listen on"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development").describe("Application environment"),
  DATABASE_URL: z.string().url().describe("PostgreSQL connection string"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000").describe("Allowed CORS origin for frontend"),
  JWT_SECRET: z.string().min(32).describe("Secret key for signing JSON Web Tokens"),

  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet").describe("Stellar network to connect to"),
  STELLAR_RPC_URL: z.string().url().describe("Soroban RPC endpoint URL"),
  STELLAR_HORIZON_URL: z.string().url().describe("Stellar Horizon API endpoint URL"),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(10).describe("Stellar network passphrase"),

  TARIFF_SHIELD_CONTRACT_ID: z.string().startsWith("C").min(56).describe("Soroban contract ID for TariffShield"),
  PLATFORM_STELLAR_SECRET: z.string().startsWith("S").min(56).describe("Admin/platform Stellar secret key"),
  ADMIN_2_SECRET: z.string().startsWith("S").min(56).optional().describe("Admin 2 Stellar secret key for multi-sig upgrade"),
  ADMIN_3_SECRET: z.string().startsWith("S").min(56).optional().describe("Admin 3 Stellar secret key for multi-sig upgrade"),
  SURETY_STELLAR_SECRET: z.string().startsWith("S").min(56).describe("Surety provider Stellar secret key"),
  METRICS_ALLOWED_CIDR: z.string().optional().describe("CIDR block allowed to access Prometheus metrics"),
  CBP_VALIDATION_MODE: z.enum(["warn", "block"]).default("block").describe("CBP lookup failure mode"),
  ORACLE_ALERT_THRESHOLD_PCT: z.coerce.number().default(50).describe("Alert threshold for collateral change"),
  ALERT_CHANNEL: z.string().default("console").describe("Alert channel for oracle monitor"),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    const varName = issue.path[0];
    const shape = Env.shape[varName as keyof typeof Env.shape];
    const description = shape?.description || "No description provided";
    console.error(`  - ${String(varName)}: ${issue.message} - ${description}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
