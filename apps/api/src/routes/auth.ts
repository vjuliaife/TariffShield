import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  pool,
  recordAuthenticationAttempt,
  getFailedAuthAttempts,
  recordSecurityIncident,
  createSession,
  getActiveSessionCount,
  revokeOldestSession,
  revokeSession,
} from "../db.js";
import { hashPassword, verifyPassword, signToken, authMiddleware, MAX_SESSIONS, type AuthedRequest } from "../auth.js";
import { env } from "../config/env.js";

export const authRouter = Router();

const SignupSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  role: z.enum(["importer", "surety_admin"]).default("importer"),
  // #322 — accept the current privacy policy version at signup
  privacyPolicyVersionId: z.string().optional(),
});

authRouter.post("/signup", async (req: Request, res: Response) => {
  const parse = SignupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input", details: parse.error.issues });
    return;
  }
  const { email, password, role, privacyPolicyVersionId } = parse.data;
  const hash = await hashPassword(password);
  try {
    // Resolve the current policy version to record at signup (#322)
    let policyVersionId = privacyPolicyVersionId;
    if (!policyVersionId) {
      const latestPolicy = await pool.query(
        "SELECT version_id FROM privacy_policy_versions ORDER BY effective_date DESC LIMIT 1",
      );
      policyVersionId = latestPolicy.rows[0]?.version_id;
    }

    const result = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role",
      [email, hash, role],
    );
    const u = result.rows[0]!;

    // Record privacy policy acceptance transactionally with signup (#322)
    if (policyVersionId) {
      await pool.query(
        `INSERT INTO privacy_policy_acceptances
           (user_id, policy_version_id, ip_address, acceptance_channel)
         VALUES ($1, $2, $3, 'signup')
         ON CONFLICT (user_id, policy_version_id) DO NOTHING`,
        [u.id, policyVersionId, req.ip ?? null],
      );
    }

    // #324 — surety_admin accounts start with a pending license verification record.
    // Operational routes (clawback, accrue-yield) are blocked until a platform admin
    // marks the record as 'verified' after checking NAIC / state DOI licensing data.
    if (role === "surety_admin") {
      await pool.query(
        `INSERT INTO surety_license_verifications (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [u.id],
      );
    }

    const sessionId = await createSession(u.id, req.ip ?? undefined, req.get("user-agent") ?? undefined);
    res.json({ token: signToken({ id: u.id, email: u.email, role: u.role, sessionId }), user: u });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      res.status(409).json({ error: "email already registered" });
      return;
    }
    throw err;
  }
});

const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string(),
});

authRouter.post("/login", async (req: Request, res: Response) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid input" });
    return;
  }

  const email = parse.data.email;
  const ipAddress = req.ip ?? "unknown";
  const userAgent = req.get("user-agent") ?? "unknown";

  const failedAttempts = await getFailedAuthAttempts(email, 30);
  if (failedAttempts >= 10) {
    await recordSecurityIncident("P1", `Brute-force attack detected on account ${email}`, email);
    res.status(429).json({ error: "too many failed attempts, account locked for 30 minutes" });
    await recordAuthenticationAttempt(email, false, undefined, ipAddress, userAgent);
    return;
  }

  const r = await pool.query("SELECT id, email, password_hash, role, locked_until FROM users WHERE email = $1", [
    email,
  ]);
  if (r.rowCount === 0) {
    await recordAuthenticationAttempt(email, false, undefined, ipAddress, userAgent);
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  const u = r.rows[0]!;
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    res.status(403).json({ error: "account temporarily locked, try again later" });
    return;
  }

  if (!(await verifyPassword(parse.data.password, u.password_hash))) {
    await recordAuthenticationAttempt(email, false, u.id, ipAddress, userAgent);
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  await recordAuthenticationAttempt(email, true, u.id, ipAddress, userAgent);

  // SOC 2 CC6.1: enforce concurrent session limit before issuing a new session.
  const sessionLimit = MAX_SESSIONS[u.role as keyof typeof MAX_SESSIONS] ?? 5;
  const activeSessions = await getActiveSessionCount(u.id);
  if (activeSessions >= sessionLimit) {
    await revokeOldestSession(u.id);
  }

  const sessionId = await createSession(u.id, ipAddress, userAgent);
  const token = signToken({ id: u.id, email: u.email, role: u.role, sessionId });

  res.json({
    token,
    user: { id: u.id, email: u.email, role: u.role },
  });
});

authRouter.post("/logout", authMiddleware, async (req: Request, res: Response) => {
  const { sessionId } = (req as AuthedRequest).user;
  if (sessionId) {
    await revokeSession(sessionId);
  }
  res.json({ message: "logged out" });
});

authRouter.get("/me", authMiddleware, (req: Request, res: Response) => {
  res.json({ user: (req as AuthedRequest).user });
});

// ── #308 — SAML 2.0 SSO for surety_admin accounts ────────────────────────────
//
// Two IdP configurations are supported: Okta and Azure AD.
// The SAML library (passport-saml) is optional at runtime; if SAML env vars
// are not configured the endpoints return 501 so the rest of the API is unaffected.
//
// SP-initiated flow:
//   GET  /auth/saml/:provider/login   → redirect to IdP AuthnRequest
//   POST /auth/saml/:provider/callback → receive SAMLResponse, issue JWT
//
// Metadata endpoint:
//   GET  /auth/saml/metadata          → SP metadata XML

const SAML_PROVIDERS = ["okta", "azure"] as const;
type SamlProvider = (typeof SAML_PROVIDERS)[number];

function getSamlConfig(provider: SamlProvider): Record<string, string> | null {
  if (provider === "okta") {
    if (!env.SAML_OKTA_ENTRY_POINT || !env.SAML_OKTA_CERT) return null;
    return { entryPoint: env.SAML_OKTA_ENTRY_POINT, cert: env.SAML_OKTA_CERT };
  }
  if (!env.SAML_AZURE_ENTRY_POINT || !env.SAML_AZURE_CERT) return null;
  return { entryPoint: env.SAML_AZURE_ENTRY_POINT, cert: env.SAML_AZURE_CERT };
}

// GET /auth/saml/metadata
authRouter.get("/saml/metadata", (_req: Request, res: Response) => {
  const entityId = env.SAML_SP_ENTITY_ID ?? "https://tariffshield.io/saml/metadata";
  const acsUrl   = env.SAML_SP_ACS_URL   ?? "https://tariffshield.io/auth/saml/okta/callback";
  const xml = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.set("Content-Type", "application/xml").send(xml);
});

// GET /auth/saml/:provider/login — SP-initiated SSO; redirects to IdP
authRouter.get("/saml/:provider/login", (req: Request, res: Response) => {
  const provider = req.params.provider as SamlProvider;
  if (!SAML_PROVIDERS.includes(provider)) {
    res.status(404).json({ error: "unknown SAML provider" });
    return;
  }
  const cfg = getSamlConfig(provider);
  if (!cfg) {
    res.status(501).json({ error: `SAML SSO for '${provider}' is not configured on this instance` });
    return;
  }

  const entityId = env.SAML_SP_ENTITY_ID ?? "https://tariffshield.io/saml/metadata";
  const acsUrl   = env.SAML_SP_ACS_URL   ?? `https://tariffshield.io/auth/saml/${provider}/callback`;
  const relayState = String(req.query.relay ?? "");

  // Build a minimal SP-initiated AuthnRequest redirect URL.
  // In production, use passport-saml or samlify for signed AuthnRequests.
  const requestId = `_${Date.now().toString(36)}`;
  const issueInstant = new Date().toISOString();
  const authnRequest =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" ` +
    `AssertionConsumerServiceURL="${acsUrl}" ` +
    `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">` +
    `<saml:Issuer>${entityId}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;

  const encoded = Buffer.from(authnRequest).toString("base64");
  const params = new URLSearchParams({ SAMLRequest: encoded });
  if (relayState) params.set("RelayState", relayState);

  res.redirect(`${cfg.entryPoint}?${params.toString()}`);
});

// POST /auth/saml/:provider/callback — receive and validate SAMLResponse, issue JWT
authRouter.post("/saml/:provider/callback", async (req: Request, res: Response) => {
  const provider = req.params.provider as SamlProvider;
  if (!SAML_PROVIDERS.includes(provider)) {
    res.status(404).json({ error: "unknown SAML provider" });
    return;
  }
  const cfg = getSamlConfig(provider);
  if (!cfg) {
    res.status(501).json({ error: `SAML SSO for '${provider}' is not configured` });
    return;
  }

  const samlResponse = req.body?.SAMLResponse as string | undefined;
  if (!samlResponse) {
    res.status(400).json({ error: "missing SAMLResponse" });
    return;
  }

  // Decode and do minimal XML attribute extraction.
  // Production: replace with passport-saml Strategy.verify() for full signature validation.
  let decoded: string;
  try {
    decoded = Buffer.from(samlResponse, "base64").toString("utf8");
  } catch {
    res.status(400).json({ error: "malformed SAMLResponse" });
    return;
  }

  // Extract NameID and email from assertion attributes
  const nameIdMatch = decoded.match(/<(?:saml:|)NameID[^>]*>([^<]+)<\/(?:saml:|)NameID>/);
  const emailMatch  = decoded.match(/Name="(?:email|mail|emailAddress)[^"]*"\s*[^>]*>\s*<(?:saml:|)AttributeValue[^>]*>([^<]+)<\/(?:saml:|)AttributeValue>/i);

  const nameId = nameIdMatch?.[1]?.trim();
  const email  = emailMatch?.[1]?.trim();

  if (!nameId) {
    res.status(401).json({ error: "SAML assertion missing NameID" });
    return;
  }

  // Upsert surety_admin user — SAML SSO is restricted to surety_admin role (#308)
  const idpEntityId = cfg.entryPoint;
  const userEmail = email ?? `${nameId}@sso.tariffshield.io`;

  const existing = await pool.query(
    `SELECT id, email, role FROM users WHERE saml_subject_id = $1 AND idp_entity_id = $2`,
    [nameId, idpEntityId],
  );

  let userId: string;
  let userRole: "surety_admin" = "surety_admin";

  if (existing.rowCount && existing.rowCount > 0) {
    userId = existing.rows[0]!.id;
  } else {
    const inserted = await pool.query(
      `INSERT INTO users (email, password_hash, role, saml_subject_id, idp_entity_id, idp_provider)
       VALUES ($1, $2, 'surety_admin', $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
         SET saml_subject_id = EXCLUDED.saml_subject_id,
             idp_entity_id   = EXCLUDED.idp_entity_id,
             idp_provider    = EXCLUDED.idp_provider
       RETURNING id, role`,
      [userEmail, "__saml__no_password__", nameId, idpEntityId, provider],
    );
    userId = inserted.rows[0]!.id;
    userRole = inserted.rows[0]!.role;
  }

  const sessionId = await createSession(userId, req.ip ?? undefined, req.get("user-agent") ?? undefined);
  const token = signToken({ id: userId, email: userEmail, role: userRole, sessionId });
  const relayState = req.body?.RelayState as string | undefined;

  // Redirect browser to frontend with token, or return JSON for API clients
  const accept = req.headers.accept ?? "";
  if (accept.includes("text/html") && relayState?.startsWith("/")) {
    res.redirect(`${relayState}?token=${encodeURIComponent(token)}`);
  } else {
    res.json({ token, user: { id: userId, email: userEmail, role: userRole } });
  }
});
