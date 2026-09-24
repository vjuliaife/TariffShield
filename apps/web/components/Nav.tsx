'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getUser, type AuthUser } from '@/lib/auth';

export function Nav() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const network =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STELLAR_NETWORK) || 'testnet';

  useEffect(() => {
    setUser(getUser());
  }, []);

  function logout() {
    clearSession();
    router.push('/');
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
        <div className="flex items-center gap-4 text-sm">
          {user ? (
            <>
              <div className="flex flex-col items-start leading-tight">
                {user.role === 'importer' ? (
                  <>
                    <Link href="/app" className="text-foreground hover:text-accent">
                      Bond dashboard
                    </Link>
                    <Link href="/app/settings" className="text-foreground hover:text-accent">
                      Account settings
                    </Link>
                  </>
                ) : (
                  <Link href="/surety" className="text-foreground hover:text-accent">
                    Surety admin
                  </Link>
                )}
                <span
                  className="text-[11px] text-muted sm:hidden max-w-[130px] truncate"
                  title={user.email}
                >
                  {user.email}
                </span>
              </div>
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
      </div>
    </nav>
  );
}
