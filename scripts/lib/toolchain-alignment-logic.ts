import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Toolchain alignment checks.
 *
 * #897 — the Node runtime used by CI, Docker images, the devcontainer and
 * .nvmrc must be a single major, engines.node must start at that major, and
 * every workspace's @types/node must target that same major. Typings from a
 * newer Node major describe APIs (fetch/stream additions, new globals) that do
 * not exist at runtime, so code could type-check and still crash on deploy.
 *
 * #896 — soroban-env-host releases before 25.2.2 (including the 22.x line we
 * use) declare `ed25519-dalek = ">=2.0.0"` with no upper bound, so the
 * contract crate must pin ed25519-dalek 2 as a dev-dependency. Releases that
 * bound it themselves (`^2.0.0`) make the pin redundant.
 */

export const PACKAGES_WITH_NODE_TYPES = ["apps/api", "apps/web", "packages/sdk"] as const;

/** First soroban-env-host release per major that bounds ed25519-dalek to ^2. */
export const ENV_HOST_DALEK_BOUND_SINCE: Readonly<Record<number, string>> = Object.freeze({
  25: "25.2.2",
  26: "26.1.4",
  27: "27.0.1",
  28: "28.0.0",
});

export interface Problem {
  source: string;
  message: string;
}

/**
 * Leading major from a version or range: "20", "'20'", "20.x", "v20.11.0",
 * "^24.0.0", "~20.1", ">=20", ">=20 <21", "node:20-alpine". Returns null for
 * anything without an explicit major (e.g. "lts/*", "latest").
 */
export function parseNodeMajor(spec: string | undefined | null): number | null {
  if (spec == null) return null;
  const match = /^\s*['"]?\s*(?:>=|\^|~|=|v)?\s*(\d+)/.exec(String(spec));
  return match ? Number(match[1]) : null;
}

export interface RuntimeSource {
  source: string;
  major: number | null;
}

export interface NodeToolchainSnapshot {
  enginesNode: string | null;
  runtimes: RuntimeSource[];
  typesNode: Record<string, string | null>;
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(filter)
    .sort()
    .map((name) => path.join(dir, name));
}

/** Collect every place the repo declares a Node version. */
export function collectNodeToolchain(repoRoot: string): NodeToolchainSnapshot {
  const rel = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/");
  const runtimes: RuntimeSource[] = [];

  const nvmrc = readIfExists(path.join(repoRoot, ".nvmrc"));
  if (nvmrc !== null) runtimes.push({ source: ".nvmrc", major: parseNodeMajor(nvmrc.trim()) });

  const workflows = listFiles(path.join(repoRoot, ".github", "workflows"), (n) => /\.ya?ml$/.test(n));
  for (const file of workflows) {
    const text = fs.readFileSync(file, "utf-8");
    for (const m of text.matchAll(/node-version:\s*([^\s#]+)/g)) {
      runtimes.push({ source: rel(file), major: parseNodeMajor(m[1]) });
    }
  }

  const dockerfiles = [
    path.join(repoRoot, "Dockerfile"),
    ...["apps", "packages"].flatMap((group) =>
      listFiles(path.join(repoRoot, group), () => true).map((dir) => path.join(dir, "Dockerfile")),
    ),
  ];
  for (const file of dockerfiles) {
    const text = readIfExists(file);
    if (text === null) continue;
    for (const m of text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?node:(\S+)/gim)) {
      runtimes.push({ source: rel(file), major: parseNodeMajor(m[1]) });
    }
  }

  const devcontainer = readIfExists(path.join(repoRoot, ".devcontainer", "devcontainer.json"));
  if (devcontainer !== null) {
    const m = /javascript-node:(\d+)/.exec(devcontainer);
    if (m) runtimes.push({ source: ".devcontainer/devcontainer.json", major: Number(m[1]) });
  }

  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
  const typesNode: Record<string, string | null> = {};
  for (const pkgDir of PACKAGES_WITH_NODE_TYPES) {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgDir, "package.json"), "utf-8"));
    typesNode[pkgDir] =
      pkg.devDependencies?.["@types/node"] ?? pkg.dependencies?.["@types/node"] ?? null;
  }

  return { enginesNode: rootPkg.engines?.node ?? null, runtimes, typesNode };
}

/**
 * Validate a snapshot. Returns the single runtime major plus any problems.
 */
export function checkNodeAlignment(snapshot: NodeToolchainSnapshot): {
  runtimeMajor: number | null;
  problems: Problem[];
} {
  const problems: Problem[] = [];

  for (const r of snapshot.runtimes) {
    if (r.major === null) {
      problems.push({ source: r.source, message: "Node version must be pinned to an explicit major" });
    }
  }

  const majors = [...new Set(snapshot.runtimes.map((r) => r.major).filter((m): m is number => m !== null))];
  if (majors.length === 0) {
    problems.push({ source: "runtime", message: "no Node runtime version declared (.nvmrc, CI or Dockerfile)" });
    return { runtimeMajor: null, problems };
  }
  if (majors.length > 1) {
    const detail = snapshot.runtimes.map((r) => `${r.source}=${r.major}`).join(", ");
    problems.push({ source: "runtime", message: `Node runtime majors disagree: ${detail}` });
    return { runtimeMajor: null, problems };
  }
  const runtimeMajor = majors[0]!;

  const enginesMajor = parseNodeMajor(snapshot.enginesNode);
  if (enginesMajor === null) {
    problems.push({ source: "package.json", message: "engines.node must declare a minimum major" });
  } else if (enginesMajor !== runtimeMajor) {
    problems.push({
      source: "package.json",
      message: `engines.node "${snapshot.enginesNode}" starts at Node ${enginesMajor} but the runtime is Node ${runtimeMajor}`,
    });
  }

  for (const [pkgDir, range] of Object.entries(snapshot.typesNode)) {
    const typesMajor = parseNodeMajor(range);
    if (typesMajor === null) {
      problems.push({ source: `${pkgDir}/package.json`, message: "@types/node must be declared with an explicit major" });
    } else if (typesMajor !== runtimeMajor) {
      problems.push({
        source: `${pkgDir}/package.json`,
        message: `@types/node "${range}" targets Node ${typesMajor} but the runtime is Node ${runtimeMajor}`,
      });
    }
  }

  return { runtimeMajor, problems };
}

/** Compare dotted numeric versions (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Versions of a crate recorded in Cargo.lock. */
export function lockedCrateVersions(cargoLock: string, crate: string): string[] {
  cargoLock = cargoLock.replace(/\r\n/g, "\n");
  const versions: string[] = [];
  const re = /\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g;
  for (const m of cargoLock.matchAll(re)) {
    if (m[1] === crate) versions.push(m[2]!);
  }
  return versions;
}

/**
 * Whether a soroban-env-host version still needs the manual ed25519-dalek 2
 * pin. Majors 23 and below never bound dalek; 24 is treated as unbounded too.
 * Majors above the newest known entry are assumed to keep the bound.
 */
export function envHostNeedsDalekPin(envHostVersion: string): boolean {
  const major = Number(envHostVersion.split(".")[0]);
  const known = Object.keys(ENV_HOST_DALEK_BOUND_SINCE).map(Number);
  if (major < Math.min(...known)) return true;
  if (major > Math.max(...known)) return false;
  const since = ENV_HOST_DALEK_BOUND_SINCE[major];
  return since === undefined ? true : compareVersions(envHostVersion, since) < 0;
}

/** Extract the ed25519-dalek requirement from the [dev-dependencies] table. */
export function devDependencyRequirement(cargoToml: string, crate: string): string | null {
  cargoToml = cargoToml.replace(/\r\n/g, "\n");
  const section = /^\[dev-dependencies\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml);
  if (!section) return null;
  const line = new RegExp(`^${crate.replace(/[-]/g, "\\-")}\\s*=\\s*(.+)$`, "m").exec(section[1]!);
  if (!line) return null;
  const value = line[1]!.trim();
  const simple = /^"([^"]+)"/.exec(value);
  if (simple) return simple[1]!;
  const table = /version\s*=\s*"([^"]+)"/.exec(value);
  return table ? table[1]! : value;
}

/**
 * #896 — check that the ed25519-dalek dev-dependency pin matches what the
 * locked soroban-env-host actually needs, and that its comment names that
 * soroban-env-host version.
 */
export function checkDalekPin(cargoToml: string, cargoLock: string): Problem[] {
  const problems: Problem[] = [];
  const source = "contracts/tariff-shield/Cargo.toml";
  const envHosts = lockedCrateVersions(cargoLock, "soroban-env-host");
  if (envHosts.length === 0) {
    return [{ source: "Cargo.lock", message: "soroban-env-host is not in Cargo.lock" }];
  }

  const needsPin = envHosts.some(envHostNeedsDalekPin);
  const pin = devDependencyRequirement(cargoToml, "ed25519-dalek");

  if (needsPin) {
    if (pin === null || parseNodeMajor(pin) !== 2) {
      problems.push({
        source,
        message: `soroban-env-host ${envHosts.join(", ")} leaves ed25519-dalek unbounded; keep the ed25519-dalek = "2" dev-dependency pin`,
      });
    }
    for (const version of envHosts.filter(envHostNeedsDalekPin)) {
      if (!cargoToml.includes(`soroban-env-host ${version}`)) {
        problems.push({
          source,
          message: `the ed25519-dalek pin comment must name the locked soroban-env-host ${version}`,
        });
      }
    }
  } else if (pin !== null) {
    problems.push({
      source,
      message: `soroban-env-host ${envHosts.join(", ")} bounds ed25519-dalek itself; remove the redundant dev-dependency pin`,
    });
  }

  const dalek = lockedCrateVersions(cargoLock, "ed25519-dalek");
  for (const version of dalek) {
    if (parseNodeMajor(version) !== 2) {
      problems.push({ source: "Cargo.lock", message: `ed25519-dalek ${version} is locked; soroban-env-host needs 2.x` });
    }
  }

  return problems;
}
