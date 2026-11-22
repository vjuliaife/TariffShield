import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS bond_signature_reminders_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bond_record_id UUID NOT NULL REFERENCES bond_records(id) ON DELETE CASCADE,
      envelope_id TEXT NOT NULL REFERENCES bond_signatures(envelope_id) ON DELETE CASCADE,
      reminder_type TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_bond_signature_reminders_bond_sent
      ON bond_signature_reminders_log (bond_record_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bond_signature_reminders_envelope
      ON bond_signature_reminders_log (envelope_id);
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query('DROP TABLE IF EXISTS bond_signature_reminders_log');
};
