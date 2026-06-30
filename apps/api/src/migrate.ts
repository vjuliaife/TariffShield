// Standalone migration runner — sets stubs for env vars not needed during PostgreSQL migrations.

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub("JWT_SECRET", "ci-stub-jwt-secret-not-used-by-migrations-0000");
stub("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org");
stub("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org");
stub("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
stub("TARIFF_SHIELD_CONTRACT_ID", "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
stub("PLATFORM_STELLAR_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB");
stub("SURETY_STELLAR_SECRET", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC");

const { migrate, pool } = await import("./db.js");
await migrate();
await pool.end();
console.log("Migrations complete.");
