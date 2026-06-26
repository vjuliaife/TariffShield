interface BondValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  requiresIncrease: boolean;
  minimumRequired: bigint;
}

interface BondData {
  principalLegalName?: string;
  principalEin?: string;
  suretyCompanyName?: string;
  suretyFein?: string;
  bondTypeCode?: string;
  bondAmount?: bigint;
  effectiveDate?: Date;
  expiryDate?: Date;
  annualDuties?: number;
}

const CBP_BOND_TYPE_CODES = ["01", "02", "03", "04"];
const CONTINUOUS_BOND_MIN_AMOUNT = BigInt(50_000_00000000);

export function validateBondForm301(bondData: BondData): BondValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let requiresIncrease = false;
  let minimumRequired = CONTINUOUS_BOND_MIN_AMOUNT;

  if (!bondData.principalLegalName || bondData.principalLegalName.trim().length === 0) {
    errors.push("Principal legal name is required per CBP Form 301");
  }

  if (!bondData.principalEin || !validateEIN(bondData.principalEin)) {
    errors.push("Principal EIN must be valid format (XX-XXXXXXX)");
  }

  if (!bondData.suretyCompanyName || bondData.suretyCompanyName.trim().length === 0) {
    errors.push("Surety company name is required per CBP Form 301");
  }

  if (!bondData.suretyFein || !validateEIN(bondData.suretyFein)) {
    errors.push("Surety FEIN must be valid format (XX-XXXXXXX)");
  }

  if (!bondData.bondTypeCode || !CBP_BOND_TYPE_CODES.includes(bondData.bondTypeCode)) {
    errors.push("Bond type code must be one of: 01 (single transaction), 02 (continuous), 03 (annual), 04 (customs house broker)");
  }

  if (bondData.bondTypeCode === "02") {
    if (!bondData.annualDuties) {
      minimumRequired = CONTINUOUS_BOND_MIN_AMOUNT;
    } else {
      const tenPercentOfDuties = BigInt(Math.ceil(bondData.annualDuties * 0.1 * 1e7));
      minimumRequired = tenPercentOfDuties > CONTINUOUS_BOND_MIN_AMOUNT ? tenPercentOfDuties : CONTINUOUS_BOND_MIN_AMOUNT;
    }

    if (!bondData.bondAmount || bondData.bondAmount < minimumRequired) {
      errors.push(`Continuous bond must meet minimum: ${minimumRequired.toString()} stroops (${(Number(minimumRequired) / 1e7).toFixed(2)} USD)`);
      requiresIncrease = true;
    }
  }

  if (bondData.effectiveDate && bondData.expiryDate) {
    if (bondData.expiryDate <= bondData.effectiveDate) {
      errors.push("Expiry date must be after effective date");
    }

    const expiryTime = bondData.expiryDate.getTime();
    const nowTime = Date.now();
    if (expiryTime < nowTime) {
      errors.push("Bond expiry date cannot be in the past");
    }

    const daysUntilExpiry = Math.floor((expiryTime - nowTime) / (1000 * 60 * 60 * 24));
    if (daysUntilExpiry < 30) {
      warnings.push(`Bond expires in ${daysUntilExpiry} days, consider renewal soon`);
    }
  }

  if (!bondData.effectiveDate) {
    errors.push("Effective date is required");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    requiresIncrease,
    minimumRequired,
  };
}

function validateEIN(ein: string): boolean {
  const einRegex = /^\d{2}-\d{7}$/;
  return einRegex.test(ein);
}

export function calculateMinimumBondAmount(bondTypeCode: string, annualDuties?: number): bigint {
  if (bondTypeCode !== "02") {
    return BigInt(0);
  }

  if (!annualDuties || annualDuties === 0) {
    return CONTINUOUS_BOND_MIN_AMOUNT;
  }

  const tenPercent = BigInt(Math.ceil(annualDuties * 0.1 * 1e7));
  return tenPercent > CONTINUOUS_BOND_MIN_AMOUNT ? tenPercent : CONTINUOUS_BOND_MIN_AMOUNT;
}
