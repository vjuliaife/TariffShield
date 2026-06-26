import { z } from "zod";

const Env = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().describe("Public URL of the backend API"),
  NEXT_PUBLIC_STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet").describe("Stellar network to connect to"),
  NEXT_PUBLIC_CONTRACT_ID: z.string().startsWith("C").min(56).describe("Soroban contract ID for TariffShield"),
});

const parsed = Env.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  NEXT_PUBLIC_CONTRACT_ID: process.env.NEXT_PUBLIC_CONTRACT_ID,
});

if (!parsed.success) {
  console.error("❌ Invalid frontend environment variables:");
  for (const issue of parsed.error.issues) {
    const varName = issue.path[0];
    const shape = Env.shape[varName as keyof typeof Env.shape];
    const description = shape?.description || "No description provided";
    console.error(`  - ${String(varName)}: ${issue.message} - ${description}`);
  }
  process.exit(1);
}

export const env = parsed.data;
