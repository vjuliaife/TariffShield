'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { api, ApiError } from '@/lib/api';
import { setSession } from '@/lib/auth';

export default function Signup() {
  const router = useRouter();
  const [form, setForm] = useState<{
    email: string;
    password: string;
    role: 'importer' | 'surety_admin';
    referralCode: string;
    accept_tos: boolean;
  }>({ email: '', password: '', role: 'importer', referralCode: '', accept_tos: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('ref');
    if (code && /^[a-f0-9]{12}$/i.test(code))
      setForm((current) => ({ ...current, referralCode: code.toUpperCase() }));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { token, user } = await api.signup({
        ...form,
        referralCode: form.role === 'importer' ? form.referralCode || undefined : undefined,
      });
      setSession(token, user);
      router.push(user.role === 'surety_admin' ? '/surety' : '/app');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="max-w-md mx-auto px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="mt-2 text-sm text-muted">Pick your role. Demo is on Stellar testnet.</p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <label className="block">
            <span className="block text-sm font-medium">Role</span>
            <select
              value={form.role}
              onChange={(e) =>
                setForm({ ...form, role: e.target.value as 'importer' | 'surety_admin' })
              }
              className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none"
            >
              <option value="importer">Importer (CBP bondholder)</option>
              <option value="surety_admin">Surety admin (Roanoke / Avalon / etc.)</option>
            </select>
            <p className="mt-2 text-xs text-muted leading-relaxed">
              {form.role === 'importer'
                ? 'Importers post yield-bearing USDC collateral, configure auto-top-up reserves, and view active customs-bond metrics.'
                : 'Surety admins manage continuous importer portfolios, set required collateral, accrue yield, and execute emergency clawbacks.'}{' '}
              This selection determines dashboard access and permissions and{' '}
              <span className="font-semibold text-foreground/80">cannot be changed</span> after
              registration without contacting support.
            </p>
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Work email</span>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="ops@example.com"
              required
              className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium">Password</span>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="At least 8 characters"
              required
              minLength={8}
              className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </label>
          {form.role === 'importer' && (
            <label className="block">
              <span className="block text-sm font-medium">
                Referral code <span className="text-muted">(optional)</span>
              </span>
              <input
                value={form.referralCode}
                onChange={(e) => setForm({ ...form, referralCode: e.target.value.toUpperCase() })}
                maxLength={12}
                pattern="[A-Fa-f0-9]{12}"
                className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
              />
            </label>
          )}
          <label className="flex items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={form.accept_tos}
              onChange={(e) => setForm({ ...form, accept_tos: e.target.checked })}
              required
              className="mt-0.5"
            />
            <span>I accept the Terms of Service.</span>
          </label>
          {error ? (
            <p className="rounded border border-danger bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-accent px-4 py-2.5 text-accent-foreground hover:opacity-90 disabled:opacity-50 text-sm font-medium"
          >
            {loading ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="mt-6 text-sm text-muted">
          Already have an account?{' '}
          <Link href="/login" className="text-accent hover:underline">
            Log in
          </Link>
        </p>
      </main>
    </>
  );
}
