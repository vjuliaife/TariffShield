import Link from "next/link";
import { Nav } from "@/components/Nav";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-6 py-16">
        <section className="max-w-3xl">
          <p className="text-sm font-medium text-accent uppercase tracking-wide">
            Customs bond collateral · Soroban smart contracts · Stellar testnet
          </p>
          <h1 className="mt-3 text-4xl sm:text-5xl font-semibold tracking-tight text-foreground">
            Your bond collateral shouldn&apos;t earn 0%.
          </h1>
          <p className="mt-5 text-lg text-muted leading-relaxed">
            US importers post <strong className="text-foreground">$3.6B</strong> in customs-bond insufficiencies (FY25). Surety premiums up <strong className="text-foreground">200%</strong> on tariff spikes.
            Importers lock <strong className="text-foreground">50–100% cash collateral</strong> with sureties — earning <strong className="text-foreground">0%</strong> for a 314-day average lock-up.
          </p>
          <p className="mt-4 text-lg text-muted leading-relaxed">
            TariffShield replaces dead-weight cash with <strong className="text-foreground">yield-bearing USDC</strong> in a Soroban escrow contract. When tariffs spike, the contract auto-tops-up from your reserve bucket. Surety keeps clawback authority. You earn ~4–5% APY on the float.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/signup" className="rounded-md bg-accent px-5 py-2.5 text-accent-foreground hover:opacity-90 text-sm font-medium">
              Try the demo
            </Link>
            <Link href="/login" className="rounded-md border border-border px-5 py-2.5 text-sm font-medium hover:bg-card">
              Log in
            </Link>
          </div>
        </section>

        <section className="mt-16 grid gap-6 sm:grid-cols-3">
          <Card title="Soroban escrow contract">
            One deployed contract on Stellar testnet holds collateral + reserve per importer. Auto-top-up logic runs on-chain; events are
            immutable + auditable. The contract address is the source of truth.
          </Card>
          <Card title="Yield-bearing USDC">
            Demo simulates Franklin Templeton BENJI yield (~4–5% APY). Mainnet integration with real BENJI flow is a
            scoped roadmap item.
          </Card>
          <Card title="Surety clawback authority">
            The surety partner retains emergency clawback (KYC-aware asset semantics). One contract call drains a defaulting importer&apos;s escrow
            to the surety wallet + freezes the account.
          </Card>
        </section>

        <section className="mt-16 rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">How a tariff spike plays out</h2>
          <ol className="mt-3 space-y-2 text-sm list-decimal pl-5">
            <li>You sign up as an importer + register your CBP bond ID. Platform funds a Stellar account for you on testnet via friendbot.</li>
            <li>You upload your ACE Portal CSV (or synthetic data at MVP). The platform computes required collateral from annual duties × 10% × 50%.</li>
            <li>You deposit USDC into your <em>collateral</em> bucket + a margin into your <em>reserve</em> bucket. Both held by the Soroban contract.</li>
            <li>Tariff schedule changes (Section 301 hike, reciprocal regime, AD/CVD order). Your required collateral updates on-chain.</li>
            <li>One contract call (<code className="text-accent">auto_top_up</code>) moves the shortfall from reserve to collateral atomically. No paperwork. No re-underwriting. No port hold.</li>
            <li>BENJI yield accrues to your account every period. Withdrawals (above required) are one contract call.</li>
            <li>If you default, surety calls <code className="text-accent">clawback</code> — all funds move to surety wallet, account freezes. Bond stays good.</li>
          </ol>
          <p className="mt-3 text-xs text-muted">
            MVP runs on Stellar testnet with synthetic CBP data. Live ACE API + surety partner integration + real BENJI flow + mainnet config are scoped roadmap items.
          </p>
        </section>

        <footer className="mt-20 text-xs text-muted">
          MIT licensed · testnet demo · single Soroban contract
        </footer>
      </main>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted leading-relaxed">{children}</p>
    </div>
  );
}
