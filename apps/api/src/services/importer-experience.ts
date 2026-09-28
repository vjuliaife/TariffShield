export interface CoSuretyShare {
  reference: string;
  percentage: number;
}

export function hasValidParticipationTotal(participants: readonly CoSuretyShare[]): boolean {
  if (participants.length === 0 || participants.length > 20) return false;
  const basisPoints = participants.map((participant) => participant.percentage * 100);
  return (
    basisPoints.every(
      (value) =>
        Number.isFinite(value) &&
        Math.abs(value - Math.round(value)) < 1e-8 &&
        value > 0 &&
        value <= 10000
    ) && basisPoints.reduce((sum, value) => sum + Math.round(value), 0) === 10000
  );
}

export function buildOnboardingSteps(
  hasApprovedKyc: boolean,
  hasDeposit: boolean,
  hasTariffUpload: boolean
) {
  return [
    {
      id: 'kyc',
      label: 'Complete identity verification',
      href: '/app#kyc',
      complete: hasApprovedKyc,
    },
    {
      id: 'deposit',
      label: 'Make your first collateral deposit',
      href: '/app#deposit',
      complete: hasDeposit,
    },
    {
      id: 'tariff',
      label: 'Upload your tariff schedule',
      href: '/app#tariff',
      complete: hasTariffUpload,
    },
  ];
}
