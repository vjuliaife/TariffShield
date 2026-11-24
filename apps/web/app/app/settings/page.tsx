'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '@/components/Nav';
import { ImporterSetupPanel } from '@/components/ImporterSetupPanel';
import { getUser, isAuthenticated } from '@/lib/auth';

export default function ImporterSettingsPage() {
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
    } else if (getUser()?.role !== 'importer') {
      router.replace('/surety');
    }
  }, [router]);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <ImporterSetupPanel />
      </main>
    </>
  );
}
