import type { PoolClient } from 'pg';

export const up = async (client: PoolClient): Promise<void> => {
  // ── #1035: In-App NPS/Feedback Survey ─────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS nps_survey_prompts (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_dismissed_at TIMESTAMPTZ,
      last_responded_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS nps_survey_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_nps_survey_responses_created_at
      ON nps_survey_responses(created_at DESC);
  `);

  // ── #1032: Customizable Branded PDF Export Templates ──────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS report_templates (
      surety_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      logo_url TEXT,
      header_text TEXT,
      footer_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

export const down = async (client: PoolClient): Promise<void> => {
  await client.query(`
    DROP TABLE IF EXISTS nps_survey_responses CASCADE;
    DROP TABLE IF EXISTS nps_survey_prompts CASCADE;
    DROP TABLE IF EXISTS report_templates CASCADE;
  `);
};
