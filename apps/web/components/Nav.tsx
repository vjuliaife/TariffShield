'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearSession, getUser, type AuthUser } from '@/lib/auth';
import { useBranding } from '@/lib/branding';

export function Nav() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  // #998: partner/surety white-label branding, resolved at render time.
  const branding = useBranding();
  const network =
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STELLAR_NETWORK) || 'testnet';

  // #1016: In-App Changelog Feed State
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [changelogEntries, setChangelogEntries] = useState<
    Array<{ id: string; title: string; content: string; date: string; read: boolean }>
  >([]);

  useEffect(() => {
    setUser(getUser());
    fetchChangelog();
  }, []);

  async function fetchChangelog() {
    try {
      const res = await fetch('/api/v1/changelog');
      if (res.ok) {
        const data = await res.json();
        setChangelogEntries(data.entries || []);
        const unread = (data.entries || []).filter((e: any) => !e.read).length;
        setUnreadCount(unread);
      }
    } catch {
      // Graceful fallback for offline / stub environment
    }
  }

  async function markAsRead(id: string) {
    try {
      await fetch(`/api/v1/changelog/${id}/read`, { method: 'POST' });
      setChangelogEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, read: true } : e))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // Ignore network errors
    }
  }

  function logout() {
    clearSession();
    router.push('/');
  }

  return (
    <>
      <nav className="border-b border-border bg-card">
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
                {/* #1016 Changelog Trigger Button */}
                <button
                  onClick={() => setIsChangelogOpen(true)}
                  className="relative p-2 text-foreground hover:text-accent rounded-md border border-border"
                  title="What's New / Release Notes"
                  aria-label="Release Notes"
                >
                  <span className="text-base">📢</span>
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
      </nav>

      {/* #1016 Release Notes / Changelog Slide-over Panel */}
      {isChangelogOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-card h-full p-6 shadow-xl border-l border-border flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <h2 className="text-lg font-bold text-foreground">Release Notes & Updates</h2>
              <button
                onClick={() => setIsChangelogOpen(false)}
                className="text-muted hover:text-foreground text-xl font-bold px-2"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {changelogEntries.length === 0 ? (
                <p className="text-muted text-sm">No recent product updates.</p>
              ) : (
                changelogEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={`p-4 rounded-lg border ${entry.read ? 'border-border bg-card' : 'border-accent/40 bg-accent/5'}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="font-semibold text-foreground text-sm">{entry.title}</h3>
                      <span className="text-xs text-muted">{entry.date}</span>
                    </div>
                    <div
                      className="text-xs text-muted space-y-2 prose prose-sm dark:prose-invert"
                      dangerouslySetInnerHTML={{ __html: entry.content }}
                    />
                    {!entry.read && (
                      <button
                        onClick={() => markAsRead(entry.id)}
                        className="mt-3 text-xs text-accent hover:underline font-medium"
                      >
                        Mark as read
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
