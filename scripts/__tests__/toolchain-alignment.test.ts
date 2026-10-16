import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkDalekPin,
  checkNodeAlignment,
  collectNodeToolchain,
  compareVersions,
  devDependencyRequirement,
  envHostNeedsDalekPin,
  lockedCrateVersions,
  parseNodeMajor,
  type NodeToolchainSnapshot,
} from "../lib/toolchain-alignment-logic.js";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

function snapshot(overrides: Partial<NodeToolchainSnapshot> = {}): NodeToolchainSnapshot {
  return {
    enginesNode: ">=20",
    runtimes: [
      { source: ".nvmrc", major: 20 },
      { source: ".github/workflows/ci.yml", major: 20 },
      { source: "apps/api/Dockerfile", major: 20 },
    ],
    typesNode: { "apps/api": "^20.19.0", "apps/web": "^20.19.0", "packages/sdk": "^20.19.0" },
    ...overrides,
  };
}

describe("parseNodeMajor (#897)", () => {
  it("reads the major from versions, ranges and image tags", () => {
    assert.equal(parseNodeMajor("20"), 20);
    assert.equal(parseNodeMajor("'20'"), 20);
    assert.equal(parseNodeMajor('"20"'), 20);
    assert.equal(parseNodeMajor("20.x"), 20);
    assert.equal(parseNodeMajor("v20.11.1"), 20);
    assert.equal(parseNodeMajor("^24.0.0"), 24);
    assert.equal(parseNodeMajor("~20.1"), 20);
    assert.equal(parseNodeMajor(">=20"), 20);
    assert.equal(parseNodeMajor(">= 22 <23"), 22);
    assert.equal(parseNodeMajor("20-alpine"), 20);
  });

  it("returns null when there is no explicit major", () => {
    assert.equal(parseNodeMajor("lts/*"), null);
    assert.equal(parseNodeMajor("latest"), null);
    assert.equal(parseNodeMajor(""), null);
    assert.equal(parseNodeMajor(undefined), null);
  });
});

describe("checkNodeAlignment (#897)", () => {
  it("passes when runtime, engines and @types/node share a major", () => {
    assert.deepEqual(checkNodeAlignment(snapshot()), { runtimeMajor: 20, problems: [] });
  });

  it("flags @types/node from a newer major than the runtime", () => {
    const { problems } = checkNodeAlignment(
      snapshot({ typesNode: { "apps/api": "^24.0.0", "apps/web": "^20.19.0", "packages/sdk": "^24.0.0" } }),
    );
    assert.deepEqual(
      problems.map((p) => p.source),
      ["apps/api/package.json", "packages/sdk/package.json"],
    );
    assert.match(problems[0]!.message, /targets Node 24 but the runtime is Node 20/);
  });

  it("flags engines.node that starts below or above the runtime", () => {
    assert.match(
      checkNodeAlignment(snapshot({ enginesNode: ">=18" })).problems[0]!.message,
      /starts at Node 18 but the runtime is Node 20/,
    );
    assert.equal(checkNodeAlignment(snapshot({ enginesNode: null })).problems.length, 1);
  });

  it("flags CI, Docker and .nvmrc disagreeing on the runtime", () => {
    const result = checkNodeAlignment(
      snapshot({
        runtimes: [
          { source: ".nvmrc", major: 20 },
          { source: ".github/workflows/ci.yml", major: 22 },
        ],
      }),
    );
    assert.equal(result.runtimeMajor, null);
    assert.match(result.problems[0]!.message, /disagree: \.nvmrc=20, \.github\/workflows\/ci\.yml=22/);
  });

  it("flags unpinned runtimes and missing declarations", () => {
    const unpinned = checkNodeAlignment(
      snapshot({ runtimes: [{ source: ".github/workflows/e2e.yml", major: null }, { source: ".nvmrc", major: 20 }] }),
    );
    assert.equal(unpinned.problems[0]!.source, ".github/workflows/e2e.yml");

    const none = checkNodeAlignment(snapshot({ runtimes: [] }));
    assert.equal(none.runtimeMajor, null);
    assert.match(none.problems[0]!.message, /no Node runtime version declared/);

    const missingTypes = checkNodeAlignment(snapshot({ typesNode: { "apps/api": null } }));
    assert.match(missingTypes.problems[0]!.message, /explicit major/);
  });
});

describe("collectNodeToolchain (#897)", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function write(rel: string, content: string) {
    const file = path.join(tmpDir!, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  it("reads .nvmrc, workflows, Dockerfiles, devcontainer, engines and @types/node", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-alignment-"));
    write(".nvmrc", "20\r\n");
    write(".github/workflows/ci.yml", "with:\r\n  node-version: 20\r\n  node-version: '20' # quoted\n");
    write("apps/api/Dockerfile", "FROM node:20-alpine AS builder\nFROM --platform=linux/amd64 node:20-alpine\n");
    write(".devcontainer/devcontainer.json", '{ "image": "mcr.microsoft.com/devcontainers/javascript-node:20" }');
    write("package.json", JSON.stringify({ engines: { node: ">=20" } }));
    for (const dir of ["apps/api", "apps/web", "packages/sdk"]) {
      write(`${dir}/package.json`, JSON.stringify({ devDependencies: { "@types/node": "^20.19.0" } }));
    }

    const snap = collectNodeToolchain(tmpDir);
    assert.equal(snap.enginesNode, ">=20");
    assert.deepEqual(
      snap.runtimes.map((r) => `${r.source}:${r.major}`),
      [
        ".nvmrc:20",
        ".github/workflows/ci.yml:20",
        ".github/workflows/ci.yml:20",
        "apps/api/Dockerfile:20",
        "apps/api/Dockerfile:20",
        ".devcontainer/devcontainer.json:20",
      ],
    );
    assert.deepEqual(checkNodeAlignment(snap).problems, []);
  });

  it("this repository is aligned", () => {
    const { runtimeMajor, problems } = checkNodeAlignment(collectNodeToolchain(REPO_ROOT));
    assert.deepEqual(problems, []);
    assert.equal(runtimeMajor, 20);
  });
});

describe("ed25519-dalek pin (#896)", () => {
  const lock = (envHost: string, dalek = "2.2.0") =>
    [
      "[[package]]",
      'name = "ed25519-dalek"',
      `version = "${dalek}"`,
      "",
      "[[package]]",
      'name = "soroban-env-host"',
      `version = "${envHost}"`,
      "",
    ].join("\r\n");

  const tomlWithPin = (envHost: string) =>
    [
      "[dependencies]",
      "soroban-sdk = { workspace = true }",
      "",
      "[dev-dependencies]",
      'soroban-sdk = { workspace = true, features = ["testutils"] }',
      `# soroban-env-host ${envHost} declares ed25519-dalek = ">=2.0.0"`,
      'ed25519-dalek = "2"',
      "",
    ].join("\n");

  const tomlWithoutPin = [
    "[dev-dependencies]",
    'soroban-sdk = { workspace = true, features = ["testutils"] }',
    "",
  ].join("\n");

  it("compares versions numerically", () => {
    assert.ok(compareVersions("25.2.2", "25.2.10") < 0);
    assert.ok(compareVersions("26.1.4", "26.1.3") > 0);
    assert.equal(compareVersions("27.0.1", "27.0.1"), 0);
  });

  it("knows which soroban-env-host releases leave dalek unbounded", () => {
    for (const v of ["22.1.3", "22.1.4", "23.0.2", "24.0.0", "25.2.1", "26.1.3", "27.0.0"]) {
      assert.equal(envHostNeedsDalekPin(v), true, v);
    }
    for (const v of ["25.2.2", "26.1.4", "27.0.1", "28.0.0", "29.0.2"]) {
      assert.equal(envHostNeedsDalekPin(v), false, v);
    }
  });

  it("parses Cargo.lock and the dev-dependency requirement", () => {
    assert.deepEqual(lockedCrateVersions(lock("22.1.3"), "soroban-env-host"), ["22.1.3"]);
    assert.equal(devDependencyRequirement(tomlWithPin("22.1.3").replace(/\n/g, "\r\n"), "ed25519-dalek"), "2");
    assert.equal(devDependencyRequirement('[dev-dependencies]\ned25519-dalek = { version = "2.1" }\n', "ed25519-dalek"), "2.1");
    assert.equal(devDependencyRequirement(tomlWithoutPin, "ed25519-dalek"), null);
    assert.equal(devDependencyRequirement('[dependencies]\ned25519-dalek = "2"\n', "ed25519-dalek"), null);
  });

  it("requires the pin and a matching comment on soroban-env-host 22.x", () => {
    assert.deepEqual(checkDalekPin(tomlWithPin("22.1.3"), lock("22.1.3")), []);
    assert.match(checkDalekPin(tomlWithoutPin, lock("22.1.3"))[0]!.message, /keep the ed25519-dalek = "2"/);
    assert.match(checkDalekPin(tomlWithPin("22.1.3"), lock("22.1.4"))[0]!.message, /must name the locked soroban-env-host 22\.1\.4/);
  });

  it("asks for the pin to be removed once soroban-env-host bounds dalek", () => {
    assert.match(checkDalekPin(tomlWithPin("28.0.2"), lock("28.0.2"))[0]!.message, /remove the redundant/);
    assert.deepEqual(checkDalekPin(tomlWithoutPin, lock("28.0.2")), []);
  });

  it("flags a locked dalek 3.x and a missing soroban-env-host", () => {
    assert.match(checkDalekPin(tomlWithPin("22.1.3"), lock("22.1.3", "3.0.0"))[0]!.message, /ed25519-dalek 3\.0\.0/);
    assert.equal(checkDalekPin(tomlWithPin("22.1.3"), "")[0]!.source, "Cargo.lock");
  });

  it("this repository's pin matches its locked soroban-env-host", () => {
    const toml = fs.readFileSync(path.join(REPO_ROOT, "contracts", "tariff-shield", "Cargo.toml"), "utf-8");
    const cargoLock = fs.readFileSync(path.join(REPO_ROOT, "Cargo.lock"), "utf-8");
    assert.deepEqual(checkDalekPin(toml, cargoLock), []);
  });
});
