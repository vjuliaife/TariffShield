// Standalone migration runner — sets stubs for env vars not needed during PostgreSQL migrations.

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub('JWT_SECRET', 'ci-stub-jwt-secret-not-used-by-migrations-0000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { migrate, rollback, pool } = await import('./db.js');

const action = process.argv[2] === 'rollback' ? 'rollback' : 'up';

try {
  if (action === 'rollback') {
    await rollback();
    console.log('Migration rollback completed successfully.');
  } else {
    await migrate();
    console.log('Migration apply completed successfully.');
  }
} catch (err) {
  console.error(`Migration ${action} failed:`, err);
  process.exit(1);
} finally {
  await pool.end();
}

export {};
