/**
 * Issue #674: Unit test Nav logout button clears session and redirects to home
 * 
 * Tests Nav.tsx logout handler (lines 15-18)
 * Verifies clearSession() and router.push('/') are called in correct order
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Nav } from '../Nav';

// Mock dependencies
const mockPush = vi.fn();
const mockClearSession = vi.fn();
const mockGetUser = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUser: () => mockGetUser(),
  clearSession: () => mockClearSession(),
}));

vi.mock('@/lib/branding', () => ({
  useBranding: () => ({
    brandName: 'TariffShield',
    logoDataUrl: null,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

describe('Nav logout button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock fetch for changelog API
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries: [] }),
      } as Response)
    );
  });

  it('calls clearSession and router.push when logout button is clicked', async () => {
    const user = userEvent.setup();
    
    // Mock authenticated user so "Log out" button renders
    mockGetUser.mockReturnValue({
      id: 'user123',
      email: 'importer@example.com',
      role: 'importer',
    });

    render(<Nav />);

    // Find and click the "Log out" button
    const logoutButton = screen.getByRole('button', { name: /log out/i });
    expect(logoutButton).toBeInTheDocument();

    await user.click(logoutButton);

    // Assert clearSession was called exactly once
    expect(mockClearSession).toHaveBeenCalledTimes(1);

    // Assert router.push was called with '/' exactly once
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('calls clearSession before router.push', async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];

    mockGetUser.mockReturnValue({
      id: 'user123',
      email: 'admin@example.com',
      role: 'surety_admin',
    });

    // Track call order
    mockClearSession.mockImplementation(() => {
      callOrder.push('clearSession');
    });

    mockPush.mockImplementation(() => {
      callOrder.push('router.push');
    });

    render(<Nav />);

    const logoutButton = screen.getByRole('button', { name: /log out/i });
    await user.click(logoutButton);

    // Assert clearSession is called before router.push
    expect(callOrder).toEqual(['clearSession', 'router.push']);
  });

  it('does not render logout button for unauthenticated users', () => {
    mockGetUser.mockReturnValue(null);

    render(<Nav />);

    // "Log out" button should not be present
    const logoutButton = screen.queryByRole('button', { name: /log out/i });
    expect(logoutButton).not.toBeInTheDocument();

    // Instead, "Log in" and "Sign up" links should be present
    expect(screen.getByText('Log in')).toBeInTheDocument();
    expect(screen.getByText('Sign up')).toBeInTheDocument();
  });

  it('renders logout button for importer role', () => {
    mockGetUser.mockReturnValue({
      id: 'imp123',
      email: 'importer@test.com',
      role: 'importer',
    });

    render(<Nav />);

    const logoutButton = screen.getByRole('button', { name: /log out/i });
    expect(logoutButton).toBeInTheDocument();
  });

  it('renders logout button for surety_admin role', () => {
    mockGetUser.mockReturnValue({
      id: 'admin123',
      email: 'admin@test.com',
      role: 'surety_admin',
    });

    render(<Nav />);

    const logoutButton = screen.getByRole('button', { name: /log out/i });
    expect(logoutButton).toBeInTheDocument();
  });
});
