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

  // #332 / #334 — price oracle and emergency admin secrets
  PRICE_ORACLE_CONTRACT_ID: z.string().startsWith("C").min(56).optional().describe("Soroban contract ID for the USDC/USD price oracle"),
  EMERGENCY_ADMIN_SECRET: z.string().startsWith("S").min(56).optional().describe("Emergency oracle admin Stellar secret key"),

  // #339 — separate oracle role keypair
  ORACLE_STELLAR_SECRET: z.string().startsWith("S").min(56).optional().describe("Oracle-role Stellar secret key (separate from PLATFORM_STELLAR_SECRET)"),

  // #308 — SAML 2.0 SSO
  SAML_SP_ENTITY_ID: z.string().optional().describe("SAML Service Provider entity ID (e.g. https://tariffshield.io/saml/metadata)"),
  SAML_SP_ACS_URL: z.string().url().optional().describe("SAML Assertion Consumer Service (ACS) callback URL"),
  SAML_SP_PRIVATE_KEY: z.string().optional().describe("PEM private key used to sign AuthnRequests"),
  SAML_OKTA_ENTRY_POINT: z.string().url().optional().describe("Okta SSO entry point URL"),
  SAML_OKTA_CERT: z.string().optional().describe("Okta IdP X.509 certificate (PEM, no headers)"),
  SAML_AZURE_ENTRY_POINT: z.string().url().optional().describe("Azure AD SSO entry point URL"),
  SAML_AZURE_CERT: z.string().optional().describe("Azure AD IdP X.509 certificate (PEM, no headers)"),

  // #317 — electronic bond signature (DocuSign)
  DOCUSIGN_INTEGRATION_KEY: z.string().optional().describe("DocuSign OAuth integration key"),
  DOCUSIGN_USER_ID: z.string().optional().describe("DocuSign API user ID"),
  DOCUSIGN_ACCOUNT_ID: z.string().optional().describe("DocuSign account ID"),
  DOCUSIGN_BASE_PATH: z.string().url().optional().describe("DocuSign base API path (demo or prod)"),
  DOCUSIGN_PRIVATE_KEY: z.string().optional().describe("DocuSign RSA private key for JWT grant"),
  DOCUSIGN_WEBHOOK_HMAC_KEY: z.string().optional().describe("HMAC key for verifying DocuSign Connect webhook signatures"),
  // #314 — field-level encryption
  FIELD_ENCRYPTION_KEY: z.string().min(32).optional().describe("AES-256-GCM key for encrypting EIN and PII fields (min 32 chars; use KMS-derived key in prod)"),
  FIELD_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1).describe("Active key version for field encryption; increment on rotation"),

  // #312/#319 — S3 document storage
  S3_KYC_BUCKET: z.string().optional().describe("S3 bucket name for KYC document storage (SSE-KMS encrypted)"),
  S3_REPORTS_BUCKET: z.string().optional().describe("S3 bucket name for compliance report PDFs"),
  AWS_REGION: z.string().default("us-east-1").describe("AWS region for S3/KMS operations"),

  // #319 — report email notifications
  SENDGRID_API_KEY: z.string().optional().describe("SendGrid API key for compliance report email notifications"),
  REPORT_FROM_EMAIL: z.string().email().optional().describe("From address for compliance report notification emails"),
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
