import { pool } from "../db.js";
import { encryptField, decryptField, CURRENT_KEY_VERSION, type EncryptedValue } from "../lib/field-encryption.js";

// Rolling re-encryption job (#314): updates all importer EIN values encrypted with
// an older key version to use the current version. Runs in-process; for large
// tables replace the loop with a database-side cursor with LIMIT/OFFSET.

export async function reencryptImporterEins(): Promise<void> {
  const rows = await pool.query<{ id: string; ein_encrypted: string; ein_key_version: number }>(
    `SELECT id, ein_encrypted, ein_key_version FROM importers
     WHERE ein_encrypted IS NOT NULL AND (ein_key_version IS NULL OR ein_key_version < $1)`,
    [CURRENT_KEY_VERSION],
  );

  if (!rows.rowCount) {
    console.log("[reencrypt] all EIN fields are up-to-date");
    return;
  }

  console.log(`[reencrypt] re-encrypting ${rows.rowCount} importer EIN records`);
  let updated = 0;
  let failed = 0;

  for (const row of rows.rows) {
    try {
      const oldValue: EncryptedValue = JSON.parse(row.ein_encrypted);
      const plaintext = decryptField(oldValue);
      const newValue = encryptField(plaintext);

      await pool.query(
        `UPDATE importers SET ein_encrypted = $1, ein_key_version = $2 WHERE id = $3`,
        [JSON.stringify(newValue), CURRENT_KEY_VERSION, row.id],
      );
      updated++;
    } catch (err) {
      console.error(`[reencrypt] failed for importer ${row.id}:`, err);
      failed++;
    }
  }

  console.log(`[reencrypt] done — updated: ${updated}, failed: ${failed}`);
}
