'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { clearSession, getUser, type AuthUser } from '@/lib/auth';

export function Nav() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const network =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STELLAR_NETWORK) || 'testnet';

  useEffect(() => {
    setUser(getUser());
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
      // focus first link in drawer
      const firstLink = drawerRef.current?.querySelector<HTMLElement>('a, button');
      firstLink?.focus();
    } else {
      document.body.style.overflow = '';
      hamburgerRef.current?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && drawerOpen) {
        setDrawerOpen(false);
      }
      // Focus trap: keep Tab inside drawer when open
      if (e.key === 'Tab' && drawerOpen && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  function logout() {
    clearSession();
    setDrawerOpen(false);
    router.push('/');
  }

  const navLinks = user
    ? user.role === 'importer'
      ? [{ href: '/app', label: 'Dashboard' }]
      : [{ href: '/surety', label: 'Surety' }]
    : [];

  const allDrawerLinks = user
    ? [
        { href: '/app', label: 'Dashboard' },
        { href: '/surety', label: 'Surety' },
        { href: '/settings', label: 'Settings' },
      ]
    : [
        { href: '/login', label: 'Log in' },
        { href: '/signup', label: 'Sign up' },
      ];

  function isActive(href: string) {
    return pathname === href || pathname.startsWith(href + '/');
  }

  return (
    <nav className="border-b border-border bg-card">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href={user ? (user.role === 'surety_admin' ? '/surety' : '/app') : '/'}
            className="text-lg font-semibold tracking-tight text-foreground"
          >
            <span className="text-accent">▲</span> TariffShield
          </Link>
          <span
            className={`text-xs font-semibold px-2 py-1 rounded-full ${network === 'mainnet' ? 'bg-danger/20 text-danger' : 'bg-accent/20 text-accent'}`}
          >
            {network === 'mainnet' ? '🔴 Mainnet' : '🔵 Testnet'}
          </span>
        </div>
        {/* Desktop nav - hidden on mobile */}
        <div className="hidden md:flex items-center gap-4 text-sm">
          {user ? (
            <>
              {user.role === 'importer' ? (
                <Link href="/app" className="text-foreground hover:text-accent">
                  Bond dashboard
                </Link>
              ) : (
                <Link href="/surety" className="text-foreground hover:text-accent">
                  Surety admin
                </Link>
              )}
              <span className="hidden sm:inline text-muted">{user.email}</span>
              <button
                onClick={logout}
                className="rounded-md border border-border px-3 py-1.5 hover:bg-card"
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-foreground hover:text-accent">
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground hover:opacity-90 font-medium"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
        {/* Hamburger - visible below md */}
        <button
          ref={hamburgerRef}
          type="button"
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(!drawerOpen)}
          className="md:hidden inline-flex items-center justify-center rounded-md border border-border p-2 hover:bg-background"
        >
          {drawerOpen ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          )}
        </button>
      </div>

      {/* Backdrop */}
      {drawerOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      {/* MobileNavDrawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className={`fixed left-0 top-0 z-50 h-full w-72 max-w-[80vw] bg-card border-r border-border shadow-xl md:hidden flex flex-col transition-transform duration-200 ease-in-out ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)' }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <span className="text-lg font-semibold">
            <span className="text-accent">▲</span> TariffShield
          </span>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="rounded-md p-1 hover:bg-background"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-1">
          {allDrawerLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setDrawerOpen(false)}
              className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                isActive(link.href)
                  ? 'border-l-4 font-bold bg-accent/10 text-accent'
                  : 'text-foreground hover:bg-background'
              }`}
              style={isActive(link.href) ? { borderLeftColor: 'var(--accent)' } : undefined}
            >
              {link.label}
            </Link>
          ))}
          {user ? (
            <button
              onClick={logout}
              className="mt-2 block w-full text-left rounded-md px-3 py-2 text-sm text-foreground hover:bg-background"
            >
              Sign out
            </button>
          ) : null}
          <div className="mt-6 flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Theme</span>
              <button
                type="button"
                aria-label="Toggle theme"
                className="rounded-md border border-border px-2 py-1 text-xs"
              >
                Toggle
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Network</span>
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${network === 'mainnet' ? 'bg-danger/20 text-danger' : 'bg-accent/20 text-accent'}`}>
                {network === 'mainnet' ? 'Mainnet' : 'Testnet'}
              </span>
            </div>
            <button
              type="button"
              aria-label="Notifications"
              className="flex items-center gap-2 text-sm text-muted hover:text-foreground"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-6 9-6 9h16s-6-2-6-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              Notifications
            </button>
          </div>
        </div>
        {user ? (
          <div className="border-t border-border px-4 py-3">
            <p className="text-xs text-muted">{user.email}</p>
            <p className="text-xs text-muted capitalize">{user.role.replace('_', ' ')}</p>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

export default Nav;
