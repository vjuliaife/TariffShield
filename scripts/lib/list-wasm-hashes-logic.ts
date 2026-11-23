import * as fs from "node:fs";

/** One entry in deployments/history.json. */
export interface DeploymentRecord {
  network: string;
  contractId: string;
  wasmHash: string;
  version?: string;
  deployedAt: string;
  deployedBy?: string;
}

export class DeploymentHistoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentHistoryNotFoundError";
  }
}

export class EmptyDeploymentHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyDeploymentHistoryError";
  }
}

/**
 * Reads and parses deployments/history.json from the given path.
 *
 * Throws DeploymentHistoryNotFoundError when the file doesn't exist, and
 * EmptyDeploymentHistoryError when it parses to an empty array — both are
 * thrown (rather than calling process.exit directly) so main() is the only
 * place in this script that decides how to turn an error into an exit code,
 * and so this function is testable as a plain throw/catch instead of by
 * mocking process.exit.
 */
export function loadHistory(historyPath: string): DeploymentRecord[] {
  if (!fs.existsSync(historyPath)) {
    throw new DeploymentHistoryNotFoundError(
      `deployments/history.json not found at ${historyPath}`,
    );
  }

  const historyContent = fs.readFileSync(historyPath, "utf-8");
  const history: DeploymentRecord[] = JSON.parse(historyContent);

  if (history.length === 0) {
    throw new EmptyDeploymentHistoryError("No deployment history found");
  }

  return history;
}

/**
 * Filters deployment history down to the records matching the given
 * contractId/network, falling back to the full unfiltered history when the
 * filter yields zero matches (current behavior, preserved as-is — see the
 * design-comment discussion on issue #774 about confirming this is
 * intentional rather than accidental fallback behavior).
 */
export function filterDeployments(
  history: DeploymentRecord[],
  filters: { contractId?: string; network?: string },
): DeploymentRecord[] {
  let relevantDeployments = history;

  if (filters.contractId) {
    relevantDeployments = relevantDeployments.filter(
      (d) => d.contractId === filters.contractId,
    );
  }
  if (filters.network) {
    relevantDeployments = relevantDeployments.filter(
      (d) => d.network === filters.network,
    );
  }

  if (relevantDeployments.length === 0) {
    return history;
  }

  return relevantDeployments;
}

/** Sorts deployments by deployedAt descending (most recent first). Does not mutate the input array. */
export function sortByDeployedAtDescending(
  deployments: DeploymentRecord[],
): DeploymentRecord[] {
  return [...deployments].sort(
    (a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime(),
  );
}

/**
 * Given deployments already sorted descending by deployedAt (index 0 is
 * "current"), returns the "previous deployment" used to build the rollback
 * command — index 1 — or undefined when fewer than two deployments exist.
 */
export function selectPreviousDeployment(
  sortedDeployments: DeploymentRecord[],
): DeploymentRecord | undefined {
  return sortedDeployments.length >= 2 ? sortedDeployments[1] : undefined;
}

export type OutputFormat = "table" | "json";

export class InvalidFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFormatError";
  }
}

/**
 * Parses `--format <table|json>` / `--format=<table|json>` from argv.
 * Defaults to "table". Throws InvalidFormatError on an unknown or missing value.
 */
export function parseFormat(argv: string[]): OutputFormat {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--format") {
      value = argv[i + 1];
      if (value === undefined) {
        throw new InvalidFormatError("--format requires a value (table|json)");
      }
      break;
    }
    if (arg.startsWith("--format=")) {
      value = arg.slice("--format=".length);
      break;
    }
  }
  if (value === undefined) return "table";
  if (value === "table" || value === "json") return value;
  throw new InvalidFormatError(
    `Invalid --format "${value}" (expected "table" or "json")`,
  );
}

/**
 * Renders deployments as an aligned plain-text table with wasm hash, deploy
 * timestamp, and deployer columns (plus network/version for context). The
 * first row (most recent, when given sorted input) is marked CURRENT.
 */
export function formatTable(deployments: DeploymentRecord[]): string {
  const headers = ["#", "WASM HASH", "DEPLOYED AT", "DEPLOYED BY", "NETWORK", "VERSION"];
  const rows = deployments.map((d, i) => [
    `${i + 1}${i === 0 ? "*" : ""}`,
    d.wasmHash,
    d.deployedAt,
    d.deployedBy || "unknown",
    d.network,
    d.version || "unknown",
  ]);
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, col) => c.padEnd(widths[col])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
    ...(rows.length > 0 ? ["", "* = current"] : []),
  ].join("\n");
}
