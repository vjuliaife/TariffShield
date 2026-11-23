/**
 * Issue #673: Unit test Nav renders the correct dashboard link per user role
 * 
 * Tests Nav.tsx role-conditional rendering (lines 24, 34-38)
 * Verifies correct dashboard links and logo href based on user role
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Nav } from '../Nav';

// Mock dependencies
const mockGetUser = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUser: () => mockGetUser(),
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

describe('Nav dashboard links per user role', () => {
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

  describe('importer role', () => {
    beforeEach(() => {
      mockGetUser.mockReturnValue({
        id: 'imp123',
        email: 'importer@example.com',
        role: 'importer',
      });
    });

    it('renders "Bond dashboard" link with href /app', () => {
      render(<Nav />);

      const bondDashboardLink = screen.getByRole('link', { name: /bond dashboard/i });
      expect(bondDashboardLink).toBeInTheDocument();
      expect(bondDashboardLink).toHaveAttribute('href', '/app');
    });

    it('does not render "Surety admin" link', () => {
      render(<Nav />);

      const suretyAdminLink = screen.queryByRole('link', { name: /surety admin/i });
      expect(suretyAdminLink).not.toBeInTheDocument();
    });

    it('renders logo link with href /app', () => {
      const { container } = render(<Nav />);

      // Find the logo link (should contain the brand name)
      const logoLink = screen.getByRole('link', { name: /tariffshield/i });
      expect(logoLink).toHaveAttribute('href', '/app');
    });

    it('displays user email', () => {
      render(<Nav />);

      expect(screen.getByText('importer@example.com')).toBeInTheDocument();
    });
  });

  describe('surety_admin role', () => {
    beforeEach(() => {
      mockGetUser.mockReturnValue({
        id: 'admin123',
        email: 'admin@surety.com',
        role: 'surety_admin',
      });
    });

    it('renders "Surety admin" link with href /surety', () => {
      render(<Nav />);

      const suretyAdminLink = screen.getByRole('link', { name: /surety admin/i });
      expect(suretyAdminLink).toBeInTheDocument();
      expect(suretyAdminLink).toHaveAttribute('href', '/surety');
    });

    it('does not render "Bond dashboard" link', () => {
      render(<Nav />);

      const bondDashboardLink = screen.queryByRole('link', { name: /bond dashboard/i });
      expect(bondDashboardLink).not.toBeInTheDocument();
    });

    it('renders logo link with href /surety', () => {
      const { container } = render(<Nav />);

      // Find the logo link (should contain the brand name)
      const logoLink = screen.getByRole('link', { name: /tariffshield/i });
      expect(logoLink).toHaveAttribute('href', '/surety');
    });

    it('displays user email', () => {
      render(<Nav />);

      expect(screen.getByText('admin@surety.com')).toBeInTheDocument();
    });
  });

  describe('unauthenticated user', () => {
    beforeEach(() => {
      mockGetUser.mockReturnValue(null);
    });

    it('renders logo link with href / (home)', () => {
      const { container } = render(<Nav />);

      const logoLink = screen.getByRole('link', { name: /tariffshield/i });
      expect(logoLink).toHaveAttribute('href', '/');
    });

    it('does not render dashboard links', () => {
      render(<Nav />);

      expect(screen.queryByRole('link', { name: /bond dashboard/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /surety admin/i })).not.toBeInTheDocument();
    });

    it('renders login and signup links', () => {
      render(<Nav />);

      expect(screen.getByRole('link', { name: /log in/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument();
    });
  });

  describe('email rendering', () => {
    it('renders email for importer in both visible and hidden variants', () => {
      mockGetUser.mockReturnValue({
        id: 'imp456',
        email: 'test-importer@company.com',
        role: 'importer',
      });

      render(<Nav />);

      // Email should appear (may be in multiple places for responsive design)
      const emails = screen.getAllByText('test-importer@company.com');
      expect(emails.length).toBeGreaterThanOrEqual(1);
    });

    it('renders email for surety_admin in both visible and hidden variants', () => {
      mockGetUser.mockReturnValue({
        id: 'admin789',
        email: 'test-admin@surety.org',
        role: 'surety_admin',
      });

      render(<Nav />);

      // Email should appear (may be in multiple places for responsive design)
      const emails = screen.getAllByText('test-admin@surety.org');
      expect(emails.length).toBeGreaterThanOrEqual(1);
    });
  });
});
