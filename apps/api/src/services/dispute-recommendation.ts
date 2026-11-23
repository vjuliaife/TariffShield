// #1008 — automated dispute-resolution recommendation engine.
//
// ADVISORY ONLY: nothing in this module ever resolves a dispute; it only
// summarises collateral + payment history into a suggested accept/reject with
// the supporting factors, for a surety admin to weigh before calling
// resolve_dispute. The full factor/weight table is documented in
// docs/dispute-recommendation.md for audit purposes — keep the two in sync.
//
// Semantics (matching resolve_dispute in contracts/tariff-shield/src/lib.rs):
//   accept — keep the new oracle-required collateral;
//   reject — revert to the pre-dispute requirement.
import { pool } from '../db.js';
import { contractClient } from '../stellar.js';
import { logger } from '../lib/logger.js';

export type RecommendationDirection = 'accept' | 'reject' | 'neutral';

export interface RecommendationFactor {
  key: 'coverage' | 'change_magnitude' | 'history_stability' | 'payment_discipline' | 'past_disputes';
  label: string;
  detail: string;
  direction: RecommendationDirection;
  /** Signed contribution to the final score; positive leans accept. */
  weight: number;
}

export interface DisputeRecommendation {
  importerId: string;
  suggestion: 'accept' | 'reject';
  confidence: 'low' | 'medium' | 'high';
  score: number;
  advisoryOnly: true;
  factors: RecommendationFactor[];
  rationale: string;
  inputs: {
    collateralBalance: string;
    requiredCollateral: string;
    preDisputeRequired: string;
    coverageRatio: number | null;
    latestOracleChangePct: number | null;
    historyEntries: number;
    depositsLast90d: number;
    depositAmountLast90d: string;
    resolvedDisputes: { accepted: number; rejected: number };
    chainDataAvailable: boolean;
  };
  generatedAt: string;
}

const pctChange = (oldValue: bigint, newValue: bigint): number | null => {
  if (oldValue <= 0n) return null;
  return Number(((newValue - oldValue) * 10000n) / oldValue) / 100;
};

function coverageFactor(balance: bigint, required: bigint): RecommendationFactor {
  if (required <= 0n) {
    return {
      key: 'coverage',
      label: 'Collateral coverage',
      detail: 'No required collateral is set; coverage is neutral.',
      direction: 'neutral',
      weight: 0,
    };
  }
  const ratio = Number((balance * 100n) / required) / 100;
  if (ratio >= 1) {
    return {
      key: 'coverage',
      label: 'Collateral coverage',
      detail: `Balance covers ${ratio.toFixed(2)}× the required collateral — importer can absorb the new requirement.`,
      direction: 'accept',
      weight: 3,
    };
  }
  if (ratio >= 0.8) {
    return {
      key: 'coverage',
      label: 'Collateral coverage',
      detail: `Balance covers ${ratio.toFixed(2)}× of the requirement — near threshold.`,
      direction: 'neutral',
      weight: 0,
    };
  }
  return {
    key: 'coverage',
    label: 'Collateral coverage',
    detail: `Balance covers only ${ratio.toFixed(2)}× of the requirement — the increase is materially burdensome.`,
    direction: 'reject',
    weight: -3,
  };
}

function changeMagnitudeFactor(pct: number | null): RecommendationFactor {
  if (pct === null) {
    return {
      key: 'change_magnitude',
      label: 'Requirement change magnitude',
      detail: 'No prior requirement on record; magnitude could not be measured.',
      direction: 'neutral',
      weight: 0,
    };
  }
  if (pct <= 0) {
    return {
      key: 'change_magnitude',
      label: 'Requirement change magnitude',
      detail: `Requirement change of ${pct.toFixed(1)}% does not increase the burden — dispute has little merit.`,
      direction: 'accept',
      weight: 2,
    };
  }
  if (pct >= 50) {
    return {
      key: 'change_magnitude',
      label: 'Requirement change magnitude',
      detail: `Requirement jumped ${pct.toFixed(1)}% — a large increase that justifies the importer's dispute.`,
      direction: 'reject',
      weight: -2,
    };
  }
  return {
    key: 'change_magnitude',
    label: 'Requirement change magnitude',
    detail: `Requirement increased ${pct.toFixed(1)}% — moderate and within normal oracle drift.`,
    direction: 'accept',
    weight: 2,
  };
}

function historyStabilityFactor(history: Array<{ value: bigint; timestamp: bigint }>): RecommendationFactor {
  if (history.length < 3) {
    return {
      key: 'history_stability',
      label: 'Collateral history stability',
      detail: `Only ${history.length} historical requirement(s) on record — not enough to judge stability.`,
      direction: 'neutral',
      weight: 0,
    };
  }
  let sumAbsDelta = 0;
  let comparisons = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!.value;
    const curr = history[i]!.value;
    if (prev <= 0n) continue;
    sumAbsDelta += Math.abs(pctChange(prev, curr) ?? 0);
    comparisons += 1;
  }
  const meanAbsDelta = comparisons > 0 ? sumAbsDelta / comparisons : 0;
  if (meanAbsDelta <= 10) {
    return {
      key: 'history_stability',
      label: 'Collateral history stability',
      detail: `Requirement has moved ±${meanAbsDelta.toFixed(1)}% on average — a stable oracle history supports enforcing the latest value.`,
      direction: 'accept',
      weight: 1,
    };
  }
  if (meanAbsDelta <= 50) {
    return {
      key: 'history_stability',
      label: 'Collateral history stability',
      detail: `Requirement has moved ±${meanAbsDelta.toFixed(1)}% on average — moderate volatility.`,
      direction: 'neutral',
      weight: 0,
    };
  }
  return {
    key: 'history_stability',
    label: 'Collateral history stability',
    detail: `Requirement has moved ±${meanAbsDelta.toFixed(1)}% on average — a volatile history weakens confidence in the new value.`,
    direction: 'reject',
    weight: -1,
  };
}

function paymentDisciplineFactor(
  depositsLast90d: number,
  hasShortfall: boolean
): RecommendationFactor {
  if (depositsLast90d > 0) {
    return {
      key: 'payment_discipline',
      label: 'Payment discipline (90d)',
      detail: `${depositsLast90d} collateral deposit(s) in the last 90 days — importer has been funding the bond.`,
      direction: 'accept',
      weight: 2,
    };
  }
  if (hasShortfall) {
    return {
      key: 'payment_discipline',
      label: 'Payment discipline (90d)',
      detail: 'No deposits in the last 90 days while under-collateralised.',
      direction: 'reject',
      weight: -2,
    };
  }
  return {
    key: 'payment_discipline',
    label: 'Payment discipline (90d)',
    detail: 'No deposits in the last 90 days, but the requirement is already met.',
    direction: 'neutral',
    weight: 0,
  };
}

function pastDisputesFactor(accepted: number, rejected: number): RecommendationFactor {
  if (accepted + rejected === 0) {
    return {
      key: 'past_disputes',
      label: 'Past dispute outcomes',
      detail: 'No previously resolved disputes for this importer.',
      direction: 'neutral',
      weight: 0,
    };
  }
  if (rejected > accepted) {
    return {
      key: 'past_disputes',
      label: 'Past dispute outcomes',
      detail: `${rejected} prior dispute(s) were resolved in the importer's favour — precedent weighs against enforcing this increase.`,
      direction: 'reject',
      weight: -1,
    };
  }
  return {
    key: 'past_disputes',
    label: 'Past dispute outcomes',
    detail: `${accepted} prior dispute(s) upheld the surety's requirement — precedent supports accepting.`,
    direction: 'accept',
    weight: 1,
  };
}

/**
 * Builds the advisory recommendation for an importer's open collateral
 * dispute. On-chain reads (account, collateral history) are best-effort: if
 * Soroban RPC is unreachable the recommendation is still produced from
 * database inputs with reduced confidence and `chainDataAvailable: false`.
 */
export async function buildDisputeRecommendation(
  importerId: string
): Promise<DisputeRecommendation | null> {
  const importerResult = await pool.query(
    'SELECT id, stellar_address FROM importers WHERE id = $1 AND deleted_at IS NULL',
    [importerId]
  );
  if (!importerResult.rowCount) return null;
  const stellarAddress: string = importerResult.rows[0].stellar_address;

  // On-chain inputs (best-effort).
  let balance = 0n;
  let required = 0n;
  let preDisputeRequired = 0n;
  let chainDataAvailable = false;
  let history: Array<{ value: bigint; timestamp: bigint }> = [];
  try {
    const [acct, historyEntries] = await Promise.all([
      contractClient.getAccount(stellarAddress),
      contractClient.getCollateralHistory(stellarAddress),
    ]);
    balance = BigInt(acct.collateralBalance);
    required = BigInt(acct.requiredCollateral);
    preDisputeRequired = BigInt(acct.preDisputeRequired);
    history = historyEntries.map((e) => ({ value: e.value, timestamp: e.timestamp }));
    chainDataAvailable = true;
  } catch (err) {
    logger.warn({ err, importerId }, 'dispute recommendation: on-chain reads unavailable');
  }

  // Disputed context: prefer the open dispute row's old/new values when present.
  const disputeResult = await pool.query(
    `SELECT old_required::text AS old_required, new_required::text AS new_required
     FROM collateral_disputes
     WHERE importer_id = $1 AND status = 'open'
     ORDER BY raised_at DESC LIMIT 1`,
    [importerId]
  );
  const openDispute = disputeResult.rows[0];
  const effectiveNew = openDispute ? BigInt(openDispute.new_required) : required;
  const effectiveOld = openDispute
    ? BigInt(openDispute.old_required)
    : preDisputeRequired > 0n
      ? preDisputeRequired
      : history.length > 0
        ? history[history.length - 1]!.value
        : 0n;

  // Latest oracle change for context/fallback.
  const oracleResult = await pool.query(
    `SELECT pct_change::text AS pct_change, required_collateral::text AS required_collateral,
            previous_collateral::text AS previous_collateral
     FROM oracle_price_feed
     WHERE importer_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [importerId]
  );
  const latestOracle = oracleResult.rows[0];
  const oraclePct = latestOracle ? Number(latestOracle.pct_change) : null;

  // Past resolved dispute outcomes.
  const pastResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'resolved_accepted') AS accepted,
       COUNT(*) FILTER (WHERE status = 'resolved_rejected') AS rejected
     FROM collateral_disputes
     WHERE importer_id = $1 AND status IN ('resolved_accepted', 'resolved_rejected')`,
    [importerId]
  );
  const accepted = Number(pastResult.rows[0]?.accepted ?? 0);
  const rejected = Number(pastResult.rows[0]?.rejected ?? 0);

  // Payment history: deposits over the last 90 days.
  const depositResult = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
     FROM contract_events
     WHERE importer_id = $1
       AND kind IN ('deposit', 'deposit_collateral', 'deposit_reserve', 'auto_top_up')
       AND created_at > now() - interval '90 days'`,
    [importerId]
  );
  const depositsLast90d = Number(depositResult.rows[0]?.cnt ?? 0);
  const depositAmountLast90d = String(depositResult.rows[0]?.total ?? '0');

  const changePct = effectiveOld > 0n ? pctChange(effectiveOld, effectiveNew) : oraclePct;
  const shortfall = effectiveNew > balance ? effectiveNew - balance : 0n;

  const factors: RecommendationFactor[] = [
    coverageFactor(balance, effectiveNew),
    changeMagnitudeFactor(changePct),
    historyStabilityFactor(history),
    paymentDisciplineFactor(depositsLast90d, shortfall > 0n),
    pastDisputesFactor(accepted, rejected),
  ];

  const score = factors.reduce((sum, f) => sum + f.weight, 0);
  const suggestion: 'accept' | 'reject' = score >= 0 ? 'accept' : 'reject';

  const decisive = factors.filter((f) => f.direction !== 'neutral');
  const rationale =
    decisive.length === 0
      ? 'No decisive factors available — review the collateral and payment history manually before resolving.'
      : decisive
          .map((f) => `${f.label}: ${f.detail}`)
          .join(' ');

  const magnitude = Math.abs(score);
  let confidence: 'low' | 'medium' | 'high' = magnitude >= 5 ? 'high' : magnitude >= 2 ? 'medium' : 'low';
  if (!chainDataAvailable) confidence = 'low';

  return {
    importerId,
    suggestion,
    confidence,
    score,
    advisoryOnly: true,
    factors,
    rationale,
    inputs: {
      collateralBalance: balance.toString(),
      requiredCollateral: effectiveNew.toString(),
      preDisputeRequired: effectiveOld.toString(),
      coverageRatio:
        effectiveNew > 0n ? Number((balance * 100n) / effectiveNew) / 100 : null,
      latestOracleChangePct: oraclePct,
      historyEntries: history.length,
      depositsLast90d,
      depositAmountLast90d,
      resolvedDisputes: { accepted, rejected },
      chainDataAvailable,
    },
    generatedAt: new Date().toISOString(),
  };
}
