import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { DemoDashboard } from '@/components/DemoDashboard';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'TariffShield - Real-Time Customs Bond Collateral Management on Stellar',
  description: 'Yield-bearing USDC escrow on Stellar Soroban for customs bond collateral. Auto top-up, 4-5% APY, surety clawback. Built on Stellar testnet.',
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted leading-relaxed">{children}</p>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-16">
        {/* Hero */}
        <section className="max-w-3xl">
          <p className="text-sm font-medium text-accent uppercase tracking-wide">
            Customs bond collateral · Soroban smart contracts · Stellar testnet
          </p>
          <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight text-foreground">
            Real-Time Customs Bond Collateral Management on Stellar
          </h1>
          <p className="mt-5 text-lg text-muted leading-relaxed">
            TariffShield replaces dead-weight cash with{' '}
            <strong className="text-foreground">yield-bearing USDC</strong> in a Soroban escrow
            contract. When tariffs spike, the contract auto-tops-up from your reserve bucket. Surety
            keeps clawback authority. You earn ~4–5% APY on the float.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="rounded-md bg-accent px-5 py-2.5 text-accent-foreground hover:opacity-90 text-sm font-medium"
            >
              Get Started
            </Link>
            <a
              href="#demo"
              className="rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-card"
            >
              See Demo
            </a>
          </div>
        </section>

        {/* Interactive Demo */}
        <section id="demo" className="mt-16 rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">Interactive Demo — Live Bond Monitoring</h2>
          <p className="mt-1 text-sm text-muted">Simulated SSE stream animates collateral values every 3 seconds — no API calls, no sign-up required.</p>
          <div className="mt-6">
            <DemoDashboard />
          </div>
        </section>

        {/* How It Works 3-step */}
        <section className="mt-16">
          <h2 className="text-2xl font-semibold tracking-tight text-center">How It Works</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent text-xl">①</div>
              <h3 className="mt-4 text-sm font-semibold">Register your bond</h3>
              <p className="mt-2 text-sm text-muted">Create your importer profile and register your CBP bond ID on-chain. Platform funds a Stellar testnet account via friendbot.</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent text-xl">②</div>
              <h3 className="mt-4 text-sm font-semibold">Post collateral</h3>
              <p className="mt-2 text-sm text-muted">Deposit USDC into collateral and reserve buckets held by the Soroban escrow contract. Yield starts accruing immediately.</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-accent text-xl">③</div>
              <h3 className="mt-4 text-sm font-semibold">Earn yield</h3>
              <p className="mt-2 text-sm text-muted">BENJI yield auto-compounds while tariffs are stable. Spike hits? Contract atomically top-ups from reserve — no paperwork.</p>
            </div>
          </div>
        </section>

        {/* Why Stellar */}
        <section className="mt-16 rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">Why <span className="text-accent">Stellar</span></h2>
          <div className="mt-4 grid gap-6 sm:grid-cols-3 text-sm">
            <div>
              <h3 className="font-semibold text-accent">On-chain transparency</h3>
              <p className="mt-1 text-muted">Every deposit, top-up, and yield accrual is an immutable Soroban event. Auditable by importers, sureties, and regulators.</p>
            </div>
            <div>
              <h3 className="font-semibold text-accent">5-second settlement</h3>
              <p className="mt-1 text-muted">Stellar finality means collateral moves settle in seconds — no waiting for ACH, no port holds on tariff spikes.</p>
            </div>
            <div>
              <h3 className="font-semibold text-accent">XLM yield</h3>
              <p className="mt-1 text-muted">Escrowed USDC earns BENJI-backed 4–5% APY. Idle cash becomes productive float while staying fully collateralized.</p>
            </div>
          </div>
        </section>

        <section className="mt-16 grid gap-6 sm:grid-cols-3">
          <Card title="Soroban escrow contract">
            One deployed contract on Stellar testnet holds collateral + reserve per importer.
            Auto-top-up logic runs on-chain; events are immutable + auditable. The contract address
            is the source of truth.
          </Card>
          <Card title="Yield-bearing USDC">
            Demo simulates Franklin Templeton BENJI yield (~4–5% APY). Mainnet integration with real
            BENJI flow is a scoped roadmap item.
          </Card>
          <Card title="Surety clawback authority">
            The surety partner retains emergency clawback (KYC-aware asset semantics). One contract
            call drains a defaulting importer&apos;s escrow to the surety wallet + freezes the
            account.
          </Card>
        </section>

        {/* Footer */}
        <footer className="mt-20 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-6 text-xs text-muted">
          <span>MIT licensed · testnet demo · single Soroban contract</span>
          <div className="flex items-center gap-4">
            <Link href="/login" className="hover:text-accent">Log in</Link>
            <Link href="/signup" className="hover:text-accent">Sign up</Link>
            <a href="mailto:contact@tariffshield.io" className="hover:text-accent">Contact</a>
          </div>
        </footer>
      </main>
    </>
  );
}
