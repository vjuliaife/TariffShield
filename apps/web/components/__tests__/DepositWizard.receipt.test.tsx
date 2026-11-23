/**
 * Issue #671: Unit test DepositWizard receipt step truncates txHash to first 16 characters
 *
 * Tests DepositWizard.tsx receipt step (conditional txHash line):
 * the link text is `{txHash.slice(0, 16)}… ↗`, and the line is omitted when
 * api.deposit resolves without a txHash.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DepositWizard } from '../DepositWizard';

const mockDeposit = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    deposit: (...args: unknown[]) => mockDeposit(...args),
  },
  // error-formatter imports ApiError from the same module.
  ApiError: class ApiError extends Error {},
}));

// The guided tour opens on first visit; keep it out of the receipt assertions.
vi.mock('../DepositWizardTour', () => ({
  DepositWizardTour: () => null,
  useDepositWizardTour: () => ({ active: false, launch: () => {}, close: () => {} }),
}));

const FULL_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

async function depositAndReachReceipt(bucket: 'collateral' | 'reserve' = 'collateral') {
  const onDone = vi.fn().mockResolvedValue(undefined);
  const setError = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <DepositWizard importerId="imp-1" bucket={bucket} onDone={onDone} setError={setError} />,
  );
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  await user.click(screen.getByRole('button', { name: 'Deposit' }));
  await screen.findByText('✓ Deposit successful');
  return { ...view, onDone, setError };
}

describe('DepositWizard receipt txHash (Issue #671)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Explicit, so it doesn't depend on vitest globals being enabled.
  afterEach(() => {
    cleanup();
  });

  it('renders only the first 16 characters of a long txHash plus an ellipsis', async () => {
    mockDeposit.mockResolvedValue({ txHash: FULL_HASH, txUrl: 'https://example.test/tx' });
    await depositAndReachReceipt();

    const link = screen.getByRole('link');
    expect(link.textContent).toBe(`${FULL_HASH.slice(0, 16)}… ↗`);
    // The explorer link itself still targets the full hash.
    expect(link.getAttribute('href')).toBe(`https://stellar.expert/explorer/testnet/tx/${FULL_HASH}`);
  });

  it('does not render the full txHash anywhere in the receipt text', async () => {
    mockDeposit.mockResolvedValue({ txHash: FULL_HASH, txUrl: 'https://example.test/tx' });
    const { container } = await depositAndReachReceipt();

    expect(container.textContent).toContain(FULL_HASH.slice(0, 16));
    expect(container.textContent).not.toContain(FULL_HASH);
    expect(container.textContent).not.toContain(FULL_HASH.slice(0, 17));
  });

  it.each([undefined, null, ''])('omits the txHash line when txHash is %p', async (txHash) => {
    mockDeposit.mockResolvedValue({ txHash, txUrl: '' });
    const { setError } = await depositAndReachReceipt();

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/… ↗/)).toBeNull();
    expect(setError).not.toHaveBeenCalledWith(expect.anything());
  });

  it('still renders the deposited amount and bucket label next to the truncated hash', async () => {
    mockDeposit.mockResolvedValue({ txHash: FULL_HASH, txUrl: 'https://example.test/tx' });
    await depositAndReachReceipt('reserve');

    expect(screen.getByText('50 XLM deposited to reserve (auto-top-up pool)')).toBeTruthy();
    expect(screen.getByRole('link').textContent).toBe(`${FULL_HASH.slice(0, 16)}… ↗`);
    expect(mockDeposit).toHaveBeenCalledWith('imp-1', { amountStroops: '500000000', bucket: 'reserve' });
  });
});
