'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getUser, type AuthUser } from '@/lib/auth';
import { useBranding } from '@/lib/branding';

interface ChangelogEntry {
  id: string;
  title: string;
  version?: string;
  contentMarkdown: string;
  category: string;
  publishedAt: string;
}

export function Nav() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [showChangelog, setShowChangelog] = useState<boolean>(false);
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  // #998: partner/surety white-label branding, resolved at render time.
  const branding = useBranding();
  const network =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STELLAR_NETWORK) || 'testnet';

  useEffect(() => {
    setUser(getUser());
    if (getUser()) {
      // #1016: fetch unread changelog entries indicator
      fetch('/api/v1/changelog')
        .then((res) => res.json())
        .then((data) => {
          if (data.unreadCount) setUnreadCount(data.unreadCount);
          if (data.entries) setEntries(data.entries);
        })
        .catch(() => {});
    }
  }, []);

  function logout() {
    clearSession();
    router.push('/');
  }

  function markAsRead() {
    setShowChangelog(!showChangelog);
    if (unreadCount > 0) {
      setUnreadCount(0);
      fetch('/api/v1/changelog/read', { method: 'POST' }).catch(() => {});
    }
  }

  return (
    <nav className="border-b border-border bg-card relative">
      <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            href={user ? (user.role === 'surety_admin' ? '/surety' : '/app') : '/'}
            className="flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground"
          >
            {branding.logoDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL, nothing to optimise
              <img
                src={branding.logoDataUrl}
                alt={`${branding.brandName} logo`}
                className="h-7 w-auto max-w-[120px] object-contain"
              />
            ) : (
              <span className="text-accent">▲</span>
            )}
            <span>{branding.brandName}</span>
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
              {/* #1016 Changelog Feed Icon */}
              <button
                onClick={markAsRead}
                className="relative p-1.5 rounded-md text-foreground hover:bg-card border border-border"
                title="Product Updates & Changelog"
              >
                🔔
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground">
                    {unreadCount}
                  </span>
                )}
              </button>
              <div className="flex flex-col items-start leading-tight">
                {user.role === 'importer' ? (
                  <Link href="/app" className="text-foreground hover:text-accent">
                    Bond dashboard
                  </Link>
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

      {/* #1016 Sliding Changelog Panel */}
      {showChangelog && (
        <div className="absolute right-6 top-16 w-80 sm:w-96 rounded-lg border border-border bg-card shadow-xl z-50 p-4">
          <div className="flex items-center justify-between border-b border-border pb-2 mb-3">
            <h3 className="font-semibold text-foreground text-base">Product Updates</h3>
            <button
              onClick={() => setShowChangelog(false)}
              className="text-muted hover:text-foreground text-sm font-bold px-2 py-0.5 rounded"
            >
              ✕
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto space-y-4 pr-1">
            {entries.length === 0 ? (
              <p className="text-sm text-muted">No recent changelog entries.</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="border-b border-border/50 pb-3 last:border-b-0">
                  <div className="flex items-center justify-between text-xs text-muted mb-1">
                    <span className="font-semibold text-accent uppercase tracking-wider text-[10px]">
                      {entry.category}
                    </span>
                    <span>{new Date(entry.publishedAt).toLocaleDateString()}</span>
                  </div>
                  <h4 className="font-medium text-foreground text-sm mb-1">{entry.title}</h4>
                  <div className="text-xs text-muted leading-relaxed whitespace-pre-line">
                    {entry.contentMarkdown}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </nav>
  );
}

