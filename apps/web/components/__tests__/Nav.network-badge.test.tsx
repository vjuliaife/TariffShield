/**
 * Issue #675: Unit test Nav network badge reflects mainnet vs testnet environment variable
 * 
 * Tests Nav.tsx network derivation (line 11) and badge rendering (lines 27-29)
 * Verifies badge renders correctly based on NEXT_PUBLIC_STELLAR_NETWORK
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Nav } from '../Nav';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  getUser: vi.fn(() => null),
  clearSession: vi.fn(),
}));

vi.mock('@/lib/branding', () => ({
  useBranding: () => ({
    brandName: 'TariffShield',
    logoDataUrl: null,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

describe('Nav network badge', () => {
  const originalEnv = process.env.NEXT_PUBLIC_STELLAR_NETWORK;

  afterEach(() => {
    // Restore original environment
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    } else {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = originalEnv;
    }
  });

  it('renders "🔵 Testnet" badge with accent colors when NEXT_PUBLIC_STELLAR_NETWORK is unset', () => {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    
    const { container } = render(<Nav />);
    
    const badge = screen.getByText('🔵 Testnet');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-accent/20');
    expect(badge).toHaveClass('text-accent');
  });

  it('renders "🔴 Mainnet" badge with danger colors when NEXT_PUBLIC_STELLAR_NETWORK is "mainnet"', () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
    
    const { container } = render(<Nav />);
    
    const badge = screen.getByText('🔴 Mainnet');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-danger/20');
    expect(badge).toHaveClass('text-danger');
  });

  it('falls back to testnet badge styling for unrecognized network value', () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'futurenet';
    
    const { container } = render(<Nav />);
    
    const badge = screen.getByText('🔵 Testnet');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-accent/20');
    expect(badge).toHaveClass('text-accent');
  });

  it('renders badge identically for authenticated user', () => {
    const { getUser } = require('@/lib/auth');
    getUser.mockReturnValue({
      id: 'user123',
      email: 'importer@example.com',
      role: 'importer',
    });
    
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
    
    render(<Nav />);
    
    const badge = screen.getByText('🔴 Mainnet');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-danger/20');
    expect(badge).toHaveClass('text-danger');
  });

  it('renders badge identically for unauthenticated user', () => {
    const { getUser } = require('@/lib/auth');
    getUser.mockReturnValue(null);
    
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';
    
    render(<Nav />);
    
    const badge = screen.getByText('🔵 Testnet');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-accent/20');
    expect(badge).toHaveClass('text-accent');
  });

  it('renders testnet badge when NEXT_PUBLIC_STELLAR_NETWORK is explicitly "testnet"', () => {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';
    
    render(<Nav />);
    
    const badge = screen.getByText('🔵 Testnet');
    expect(badge).toBeInTheDocument();
  });
});
