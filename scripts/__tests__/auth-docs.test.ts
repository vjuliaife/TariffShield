import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * #898 / #899 — docs/api/auth.md must stay in sync with the auth routes.
 * These tests read the source and fail when a documented value (expiry,
 * limits, validation rules, error bodies) drifts from the implementation.
 */

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const read = (rel: string) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8").replace(/\r\n/g, "\n");

const doc = read("docs/api/auth.md");
const routes = read("apps/api/src/routes/auth.ts");
const authLib = read("apps/api/src/auth.ts");
const db = read("apps/api/src/db.ts");
const index = read("apps/api/src/index.ts");

function handler(method: "post" | "get", route: string): string {
  const start = routes.indexOf(`authRouter.${method}('${route}'`);
  assert.notEqual(start, -1, `route ${method.toUpperCase()} /auth${route} not found`);
  const next = routes.indexOf("authRouter.", start + 1);
  return routes.slice(start, next === -1 ? undefined : next);
}

function errorBodies(source: string): string[] {
  return [...source.matchAll(/error: '([^']+)'/g)].map((m) => m[1]!);
}

function section(heading: string): string {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `docs/api/auth.md is missing "${heading}"`);
  const next = doc.indexOf("\n## ", start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

function number(source: string, pattern: RegExp, label: string): number {
  const m = pattern.exec(source);
  assert.ok(m, `could not find ${label} in source`);
  return Number(m[1]);
}

describe("docs/api/auth.md — signup and login (#898)", () => {
  it("documents both endpoints with curl examples", () => {
    for (const heading of ["## POST /auth/signup", "## POST /auth/login"]) {
      const body = section(heading);
      assert.match(body, /curl -sS -X POST "\$API\/auth\/(signup|login)"/);
    }
  });

  it("documents every signup field and the password minimum", () => {
    const body = section("## POST /auth/signup");
    for (const field of ["email", "password", "role", "accept_tos", "privacyPolicyVersionId", "referralCode"]) {
      assert.ok(body.includes(`\`${field}\``), `signup field ${field} undocumented`);
    }
    const min = number(routes, /SignupSchema[\s\S]*?password: z\.string\(\)\.min\((\d+)\)/, "password min");
    assert.ok(body.includes(`At least **${min}** characters`));
    const hexLength = number(routes, /referralCode:[\s\S]*?\{(\d+)\}/, "referral code length");
    assert.ok(body.includes(`Exactly ${hexLength} hex characters`));
  });

  it("documents every error body returned by signup and login", () => {
    for (const [route, heading] of [
      ["/signup", "## POST /auth/signup"],
      ["/login", "## POST /auth/login"],
    ] as const) {
      const body = section(heading);
      for (const error of errorBodies(handler("post", route))) {
        assert.ok(body.includes(`"error": "${error}"`), `${route}: "${error}" undocumented`);
      }
    }
  });

  it("documents the MFA challenge and brute-force lockout thresholds", () => {
    const body = section("## POST /auth/login");
    assert.ok(body.includes('"mfaRequired": true'));
    const attempts = number(routes, /failedAttempts >= (\d+)/, "lockout attempts");
    const windowMin = number(routes, /getFailedAuthAttempts\(email, (\d+)\)/, "lockout window");
    assert.ok(body.includes(`${attempts} or more failed logins for this email in the last ${windowMin} minutes`));
  });

  it("documents the shared signup/login IP rate limit", () => {
    const windowMin = number(index, /const authLimiter = rateLimit\(\{\s*windowMs: (\d+) \* 60 \* 1000/, "auth limiter window");
    const max = number(index, /const authLimiter = rateLimit\(\{[\s\S]*?max: (\d+)/, "auth limiter max");
    assert.ok(section("## POST /auth/signup").includes(`${max} requests per ${windowMin} minutes per IP`));
  });
});

describe("docs/api/auth.md — token lifecycle, refresh and logout (#899)", () => {
  const lifecycle = () => section("## Token lifecycle");

  it("documents the access token, session and refresh token lifetimes", () => {
    const jwtDays = number(authLib, /expiresIn: '(\d+)d'/, "JWT expiry");
    const idleMin = number(db, /SESSION_INACTIVITY_MINUTES = (\d+)/, "session inactivity");
    const refreshDays = number(routes, /REFRESH_TOKEN_EXPIRY_DAYS = (\d+)/, "refresh expiry");
    const body = lifecycle();
    assert.ok(body.includes(`**${jwtDays} days**`), "JWT lifetime");
    assert.ok(body.includes(`**${idleMin} minutes without an authenticated request**`), "session idle");
    assert.ok(body.includes(`**${refreshDays} days**, single use`), "refresh lifetime");
  });

  it("documents the concurrent session limits", () => {
    const importer = number(authLib, /importer: (\d+),/, "importer session limit");
    const surety = number(authLib, /surety_admin: (\d+),/, "surety_admin session limit");
    assert.ok(lifecycle().includes(`importer ${importer}, surety_admin ${surety}`));
  });

  it("includes a lifecycle diagram", () => {
    assert.match(lifecycle(), /```\n[\s\S]*POST \/auth\/refresh[\s\S]*```/);
  });

  it("documents refresh request, response, rotation and every error body", () => {
    const body = lifecycle();
    assert.ok(body.includes("### POST /auth/refresh"));
    assert.ok(body.includes('{ "token": "<new access JWT>", "refreshToken": "<new refresh token>" }'));
    assert.match(body, /\*\*Rotation:\*\*/);
    for (const error of errorBodies(handler("post", "/refresh"))) {
      assert.ok(body.includes(`"error": "${error}"`), `/refresh: "${error}" undocumented`);
    }
    assert.match(body, /curl -sS -X POST "\$API\/auth\/refresh"/);
  });

  it("documents logout behaviour, including the optional refresh token", () => {
    const logout = handler("post", "/logout");
    assert.match(logout, /authMiddleware/, "logout must still require a session");
    assert.match(logout, /req\.body\?\.refreshToken/, "logout must still accept refreshToken");
    const body = lifecycle();
    assert.ok(body.includes("### POST /auth/logout"));
    assert.ok(body.includes('{ "message": "logged out" }'));
    assert.ok(body.includes("**If you leave it out, the refresh token stays valid until it expires"));
    assert.match(body, /curl -sS -X POST "\$API\/auth\/logout"/);
  });

  it("documents the auth-middleware errors logout can return", () => {
    const body = lifecycle();
    const start = authLib.indexOf("// Session-based JWT authentication");
    const end = authLib.indexOf("export function requireRole", start);
    assert.ok(start !== -1 && end !== -1, "authMiddleware JWT branch not found");
    for (const error of errorBodies(authLib.slice(start, end))) {
      if (error === "re-authentication required") continue; // pre-rollout tokens only
      assert.ok(body.includes(`"error": "${error}"`), `logout: "${error}" undocumented`);
    }
  });
});
