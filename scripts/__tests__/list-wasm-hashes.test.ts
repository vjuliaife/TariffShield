/**
 * Unit tests for scripts/lib/list-wasm-hashes-logic.ts — the filtering,
 * fallback, sort, selection, and history-loading logic behind
 * scripts/list-wasm-hashes.ts's CLI (#774).
 *
 * These pure functions were extracted out of list-wasm-hashes.ts's main()
 * specifically so they could be unit tested here against in-memory fixture
 * arrays, without shelling out to the CLI or reading a real
 * deployments/history.json from disk.
 *
 * Run via:  npm run test:scripts
 */

import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DeploymentHistoryNotFoundError,
  EmptyDeploymentHistoryError,
  filterDeployments,
  formatTable,
  InvalidFormatError,
  loadHistory,
  parseFormat,
  selectPreviousDeployment,
  sortByDeployedAtDescending,
  type DeploymentRecord,
} from "../lib/list-wasm-hashes-logic.js";
import { main } from "../list-wasm-hashes.js";

function makeDeployment(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    network: "testnet",
    contractId: "CCONTRACT1",
    wasmHash: "hash-1",
    version: "1.0.0",
    deployedAt: "2026-01-01T00:00:00.000Z",
    deployedBy: "deployer@example.com",
    ...overrides,
  };
}

describe("filterDeployments", () => {
  it("filters by contractId only", () => {
    const history = [
      makeDeployment({ contractId: "CCONTRACT1", wasmHash: "a" }),
      makeDeployment({ contractId: "CCONTRACT2", wasmHash: "b" }),
      makeDeployment({ contractId: "CCONTRACT1", wasmHash: "c" }),
    ];

    const result = filterDeployments(history, { contractId: "CCONTRACT1" });

    assert.deepEqual(
      result.map((d) => d.wasmHash),
      ["a", "c"],
    );
  });

  it("filters by network only", () => {
    const history = [
      makeDeployment({ network: "testnet", wasmHash: "a" }),
      makeDeployment({ network: "mainnet", wasmHash: "b" }),
      makeDeployment({ network: "testnet", wasmHash: "c" }),
    ];

    const result = filterDeployments(history, { network: "testnet" });

    assert.deepEqual(
      result.map((d) => d.wasmHash),
      ["a", "c"],
    );
  });

  it("filters by contractId AND network combined (both must match)", () => {
    const history = [
      makeDeployment({ contractId: "CCONTRACT1", network: "testnet", wasmHash: "a" }),
      makeDeployment({ contractId: "CCONTRACT1", network: "mainnet", wasmHash: "b" }),
      makeDeployment({ contractId: "CCONTRACT2", network: "testnet", wasmHash: "c" }),
    ];

    const result = filterDeployments(history, {
      contractId: "CCONTRACT1",
      network: "testnet",
    });

    assert.deepEqual(
      result.map((d) => d.wasmHash),
      ["a"],
    );
  });

  it("returns the full unfiltered history when no filters are provided", () => {
    const history = [makeDeployment({ wasmHash: "a" }), makeDeployment({ wasmHash: "b" })];

    const result = filterDeployments(history, {});

    assert.equal(result, history);
  });

  it("falls back to the full unfiltered history when contractId+network filtering yields zero matches", () => {
    const history = [
      makeDeployment({ contractId: "CCONTRACT1", network: "testnet", wasmHash: "a" }),
      makeDeployment({ contractId: "CCONTRACT2", network: "mainnet", wasmHash: "b" }),
    ];

    const result = filterDeployments(history, {
      contractId: "CDOES-NOT-EXIST",
      network: "futurenet",
    });

    // Fallback returns the original, unfiltered history array (same reference).
    assert.equal(result, history);
    assert.equal(result.length, 2);
  });

  it("falls back to the full history when only contractId is given and it matches nothing", () => {
    const history = [makeDeployment({ contractId: "CCONTRACT1", wasmHash: "a" })];

    const result = filterDeployments(history, { contractId: "CNOPE" });

    assert.equal(result, history);
  });
});

describe("sortByDeployedAtDescending", () => {
  it("sorts deployments most-recent-first", () => {
    const history = [
      makeDeployment({ wasmHash: "oldest", deployedAt: "2026-01-01T00:00:00.000Z" }),
      makeDeployment({ wasmHash: "newest", deployedAt: "2026-03-01T00:00:00.000Z" }),
      makeDeployment({ wasmHash: "middle", deployedAt: "2026-02-01T00:00:00.000Z" }),
    ];

    const sorted = sortByDeployedAtDescending(history);

    assert.deepEqual(
      sorted.map((d) => d.wasmHash),
      ["newest", "middle", "oldest"],
    );
  });

  it("does not mutate the input array", () => {
    const history = [
      makeDeployment({ wasmHash: "a", deployedAt: "2026-01-01T00:00:00.000Z" }),
      makeDeployment({ wasmHash: "b", deployedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const original = [...history];

    sortByDeployedAtDescending(history);

    assert.deepEqual(history, original);
  });

  it("returns an empty array unchanged", () => {
    assert.deepEqual(sortByDeployedAtDescending([]), []);
  });
});

describe("selectPreviousDeployment", () => {
  it("selects index 1 (not index 0, which is current) when there are >= 2 deployments", () => {
    const sorted = [
      makeDeployment({ wasmHash: "current" }),
      makeDeployment({ wasmHash: "previous" }),
      makeDeployment({ wasmHash: "oldest" }),
    ];

    const previous = selectPreviousDeployment(sorted);

    assert.equal(previous?.wasmHash, "previous");
  });

  it("returns undefined when there is only a single deployment (no previous to select)", () => {
    const sorted = [makeDeployment({ wasmHash: "only" })];

    assert.equal(selectPreviousDeployment(sorted), undefined);
  });

  it("returns undefined for an empty deployments array", () => {
    assert.equal(selectPreviousDeployment([]), undefined);
  });

  it("selects exactly the second element when there are exactly 2 deployments", () => {
    const sorted = [makeDeployment({ wasmHash: "current" }), makeDeployment({ wasmHash: "previous" })];

    assert.equal(selectPreviousDeployment(sorted)?.wasmHash, "previous");
  });
});

describe("loadHistory", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeTempHistory(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-wasm-hashes-test-"));
    const filePath = path.join(tmpDir, "history.json");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses and returns a valid, non-empty history file", () => {
    const filePath = writeTempHistory(
      JSON.stringify([makeDeployment({ wasmHash: "a" })]),
    );

    const history = loadHistory(filePath);

    assert.equal(history.length, 1);
    assert.equal(history[0].wasmHash, "a");
  });

  it("throws DeploymentHistoryNotFoundError when the file does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-wasm-hashes-test-"));
    const missingPath = path.join(tmpDir, "does-not-exist.json");

    assert.throws(() => loadHistory(missingPath), DeploymentHistoryNotFoundError);
  });

  it("throws EmptyDeploymentHistoryError when the file parses to an empty array", () => {
    const filePath = writeTempHistory("[]");

    assert.throws(() => loadHistory(filePath), EmptyDeploymentHistoryError);
  });
});

describe("list-wasm-hashes.ts main() error paths (process.exit mocked)", () => {
  // main() is exported specifically so these process.exit(1) paths can be
  // exercised directly: process.exit is mocked to throw (so execution stops
  // at the same point it would in a real CLI run, without actually killing
  // the test process), and the cwd is pointed at a scratch temp directory so
  // main()'s process.cwd()-relative deployments/history.json lookup resolves
  // to a controlled fixture location instead of this repo's real
  // deployments/history.json.
  const originalCwd = process.cwd();
  let tmpDir: string | undefined;

  afterEach(() => {
    mock.restoreAll();
    process.chdir(originalCwd);
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("calls process.exit(1) when deployments/history.json is missing", async () => {
    const exitMock = mock.method(process, "exit", (() => {
      throw new Error("process.exit called");
    }) as unknown as (code?: number) => never);
    const errorMock = mock.method(console, "error", () => {});

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-wasm-hashes-main-test-"));
    process.chdir(tmpDir);

    await assert.rejects(() => main(), /process\.exit called/);

    assert.ok(exitMock.mock.calls.length >= 1);
    assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    assert.ok(
      errorMock.mock.calls.some((c) =>
        String(c.arguments[0]).includes("deployments/history.json not found"),
      ),
    );
  });

  it("calls process.exit(1) when deployments/history.json is an empty array", async () => {
    const exitMock = mock.method(process, "exit", (() => {
      throw new Error("process.exit called");
    }) as unknown as (code?: number) => never);
    const errorMock = mock.method(console, "error", () => {});

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-wasm-hashes-main-test-"));
    fs.mkdirSync(path.join(tmpDir, "deployments"));
    fs.writeFileSync(path.join(tmpDir, "deployments", "history.json"), "[]");
    process.chdir(tmpDir);

    await assert.rejects(() => main(), /process\.exit called/);

    assert.ok(exitMock.mock.calls.length >= 1);
    assert.equal(exitMock.mock.calls[0].arguments[0], 1);
    assert.ok(
      errorMock.mock.calls.some((c) =>
        String(c.arguments[0]).includes("No deployment history found"),
      ),
    );
  });
});

describe("parseFormat", () => {
  it("defaults to table", () => {
    assert.equal(parseFormat([]), "table");
  });
  it("accepts --format json and --format=table", () => {
    assert.equal(parseFormat(["--format", "json"]), "json");
    assert.equal(parseFormat(["--format=table"]), "table");
  });
  it("throws on invalid or missing value", () => {
    assert.throws(() => parseFormat(["--format", "yaml"]), InvalidFormatError);
    assert.throws(() => parseFormat(["--format"]), InvalidFormatError);
  });
});

describe("formatTable", () => {
  it("renders aligned columns with hash, timestamp and deployer", () => {
    const out = formatTable([
      makeDeployment({ wasmHash: "abc123", deployedAt: "2026-02-01T00:00:00Z", deployedBy: "GDEPLOYER" }),
      makeDeployment({ wasmHash: "def4567890", deployedAt: "2026-01-01T00:00:00Z", deployedBy: undefined }),
    ]);
    const lines = out.split("\n");
    assert.match(lines[0], /^#\s+WASM HASH\s+DEPLOYED AT\s+DEPLOYED BY/);
    assert.match(lines[2], /^1\*\s+abc123\s+2026-02-01T00:00:00Z\s+GDEPLOYER/);
    assert.match(lines[3], /def4567890\s+2026-01-01T00:00:00Z\s+unknown/);
    // column alignment: DEPLOYED AT starts at the same offset in every row
    const col = lines[0].indexOf("DEPLOYED AT");
    assert.equal(lines[2].indexOf("2026-02-01"), col);
    assert.equal(lines[3].indexOf("2026-01-01"), col);
  });
});

describe("list-wasm-hashes.ts main() --format / --help", () => {
  const originalCwd = process.cwd();
  let tmpDir: string | undefined;

  afterEach(() => {
    mock.restoreAll();
    process.chdir(originalCwd);
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function setupHistory() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "list-wasm-hashes-format-test-"));
    fs.mkdirSync(path.join(tmpDir, "deployments"));
    fs.writeFileSync(
      path.join(tmpDir, "deployments", "history.json"),
      JSON.stringify([
        makeDeployment({ wasmHash: "old", deployedAt: "2026-01-01T00:00:00Z" }),
        makeDeployment({ wasmHash: "new", deployedAt: "2026-02-01T00:00:00Z" }),
      ]),
    );
    process.chdir(tmpDir);
  }

  it("prints a table by default", async () => {
    setupHistory();
    const logMock = mock.method(console, "log", () => {});
    await main([]);
    const output = logMock.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(output, /WASM HASH\s+DEPLOYED AT\s+DEPLOYED BY/);
  });

  it("prints parseable JSON sorted newest-first with --format json", async () => {
    setupHistory();
    const logMock = mock.method(console, "log", () => {});
    await main(["--format", "json"]);
    assert.equal(logMock.mock.calls.length, 1);
    const parsed = JSON.parse(String(logMock.mock.calls[0].arguments[0]));
    assert.deepEqual(parsed.map((d: DeploymentRecord) => d.wasmHash), ["new", "old"]);
  });

  it("prints usage for --help without reading history", async () => {
    const logMock = mock.method(console, "log", () => {});
    await main(["--help"]);
    assert.match(String(logMock.mock.calls[0].arguments[0]), /--format table\|json/);
  });

  it("exits 1 on an invalid --format", async () => {
    const exitMock = mock.method(process, "exit", (() => {
      throw new Error("process.exit called");
    }) as unknown as (code?: number) => never);
    mock.method(console, "error", () => {});
    await assert.rejects(() => main(["--format", "yaml"]), /process\.exit called/);
    assert.equal(exitMock.mock.calls[0].arguments[0], 1);
  });
});
