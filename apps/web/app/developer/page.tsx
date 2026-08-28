'use client';

// Client Component for the same reason as app/page.tsx: auth is a pure
// client-side mechanism (JWT in localStorage), so the authenticated fetches
// the usage dashboard depends on can only run in the browser.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '@/components/Nav';
import { DeveloperUsageDashboard } from '@/components/DeveloperUsageDashboard';
import { isAuthenticated } from '@/lib/auth';

export default function DeveloperPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Developer dashboard</h1>
        <p className="mt-1 text-sm text-muted">
          API call volume, per-category breakdown, and rate-limit headroom for your API keys
          (issue #1043). Historical usage is retained for 30 days.
        </p>
        <div className="mt-6">
          <DeveloperUsageDashboard />
        </div>
      </main>
    </div>
  );
}
