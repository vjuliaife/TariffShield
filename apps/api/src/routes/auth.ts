import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  pool,
  recordAuthenticationAttempt,
  getFailedAuthAttempts,
  recordSecurityIncident,
  createSession,
  getActiveSessionCount,
  revokeOldestSession,
  revokeSession,
  createRefreshToken,
  validateRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  authMiddleware,
  MAX_SESSIONS,
  type AuthedRequest,
} from '../auth.js';
import { env } from '../config/env.js';
import { enrollInOnboardingDrip } from '../services/onboarding-drip.js';
import { logger } from '../lib/logger.js';
import { createHash, randomBytes } from 'crypto';

export const authRouter = Router();

// Looser than the signup/login limiter applied in index.ts: these routes
// require an already-valid session (authMiddleware), so they aren't
// credential-guessing targets the way signup/login are, but still
// shouldn't be uncapped.
const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests; try again shortly' },
});

const REFRESH_TOKEN_EXPIRY_DAYS = 30;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRefreshTokenPair(
  userId: string,
  req: { ip?: string; get?: (h: string) => string | undefined }
) {
  const rawToken = randomBytes(64).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const tokenPromise = createRefreshToken(
    userId,
    tokenHash,
    expiresAt,
    req.get?.('user-agent') ?? undefined,
    req.ip ?? undefined
  );
  return { rawToken, tokenPromise, expiresAt };
}

const SignupSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  role: z.enum(['importer', 'surety_admin']).default('importer'),
  accept_tos: z.boolean().refine((val) => val === true, {
    message: 'Terms of Service must be accepted',
  }),
  // #322 — accept the current privacy policy version at signup
  privacyPolicyVersionId: z.string().optional(),
});

authRouter.post('/signup', async (req: Request, res: Response) => {
  const parse = SignupSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }
  const { email, password, role, privacyPolicyVersionId } = parse.data;
  const hash = await hashPassword(password);
  try {
    // Resolve the current policy version to record at signup (#322)
    let policyVersionId = privacyPolicyVersionId;
    if (!policyVersionId) {
      const latestPolicy = await pool.query(
        'SELECT version_id FROM privacy_policy_versions ORDER BY effective_date DESC LIMIT 1'
      );
      policyVersionId = latestPolicy.rows[0]?.version_id;
    }

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, hash, role]
    );
    const u = result.rows[0]!;

    // Record privacy policy acceptance transactionally with signup (#322)
    if (policyVersionId) {
      await pool.query(
        `INSERT INTO privacy_policy_acceptances
           (user_id, policy_version_id, ip_address, acceptance_channel)
         VALUES ($1, $2, $3, 'signup')
         ON CONFLICT (user_id, policy_version_id) DO NOTHING`,
        [u.id, policyVersionId, req.ip ?? null]
      );
    }

    // Record ToS acceptance at signup (#321)
    const latestTos = await pool.query(
      'SELECT version_id FROM tos_versions ORDER BY effective_date DESC LIMIT 1'
    );
    if (latestTos.rowCount) {
      await pool.query(
        `INSERT INTO tos_acceptances (user_id, tos_version, accepted_at, ip_address, user_agent, acceptance_method)
         VALUES ($1, $2, now(), $3, $4, 'signup')`,
        [u.id, latestTos.rows[0]?.version_id, req.ip ?? null, req.get('user-agent') ?? null]
      );
    }

    // #324 — surety_admin accounts start with a pending license verification record.
    // Operational routes (clawback, accrue-yield) are blocked until a platform admin
    // marks the record as 'verified' after checking NAIC / state DOI licensing data.
    if (role === 'surety_admin') {
      await pool.query(
        `INSERT INTO surety_license_verifications (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [u.id]
      );
    }

    // #1044 — enrol importers into the onboarding drip sequence. Best-effort:
    // a failure here must not fail signup.
    if (role === 'importer') {
      await enrollInOnboardingDrip(u.id).catch((err) => {
        logger.error({ err, userId: u.id }, 'onboarding drip enrolment failed');
      });
    }

    const sessionId = await createSession(
      u.id,
      req.ip ?? undefined,
      req.get('user-agent') ?? undefined
    );
    const refreshToken = generateRefreshTokenPair(u.id, req);
    await refreshToken.tokenPromise;
    res.json({
      token: signToken({ id: u.id, email: u.email, role: u.role, sessionId }),
      refreshToken: refreshToken.rawToken,
      user: u,
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      res.status(409).json({ error: 'email already registered' });
      return;
    }
    throw err;
  }
});

const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string(),
});

authRouter.post('/login', async (req: Request, res: Response) => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input' });
    return;
  }

  const email = parse.data.email;
  const ipAddress = req.ip ?? 'unknown';
  const userAgent = req.get('user-agent') ?? 'unknown';

  const failedAttempts = await getFailedAuthAttempts(email, 30);
  if (failedAttempts >= 10) {
    await recordSecurityIncident('P1', `Brute-force attack detected on account ${email}`, email);
    res.status(429).json({ error: 'too many failed attempts, account locked for 30 minutes' });
    await recordAuthenticationAttempt(email, false, undefined, ipAddress, userAgent);
    return;
  }

  const r = await pool.query(
    'SELECT id, email, password_hash, role, locked_until FROM users WHERE email = $1',
    [email]
  );
  if (r.rowCount === 0) {
    await recordAuthenticationAttempt(email, false, undefined, ipAddress, userAgent);
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const u = r.rows[0]!;
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    res.status(403).json({ error: 'account temporarily locked, try again later' });
    return;
  }

  if (!(await verifyPassword(parse.data.password, u.password_hash))) {
    await recordAuthenticationAttempt(email, false, u.id, ipAddress, userAgent);
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  // Check MFA status (#1014)
  const mfaCheck = await pool.query('SELECT mfa_enabled FROM users WHERE id = $1', [u.id]);
  if (mfaCheck.rows[0]?.mfa_enabled) {
    const mfaTicket = signToken({ id: u.id, email: u.email, role: u.role, type: 'mfa_challenge' });
    res.status(202).json({ mfaRequired: true, mfaTicket });
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
  const refreshToken = generateRefreshTokenPair(u.id, req);
  await refreshToken.tokenPromise;

  res.json({
    token,
    refreshToken: refreshToken.rawToken,
    user: { id: u.id, email: u.email, role: u.role },
  });
});

authRouter.post('/logout', sessionLimiter, authMiddleware, async (req: Request, res: Response) => {
  const { sessionId } = (req as AuthedRequest).user;
  if (sessionId) {
    await revokeSession(sessionId);
  }
  const tokenHash = req.body?.refreshToken ? hashToken(req.body.refreshToken) : null;
  if (tokenHash) {
    await revokeRefreshToken(tokenHash);
  }
  res.json({ message: 'logged out' });
});

// ── #1014: Self-Service Multi-Factor Authentication (MFA) Endpoints ──────────

// POST /auth/mfa/setup — initiate TOTP enrollment & generate recovery codes
authRouter.post('/mfa/setup', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const secret = randomBytes(20).toString('hex');
  const otpauthUrl = `otpauth://totp/TariffShield:${encodeURIComponent(user.email)}?secret=${secret}&issuer=TariffShield`;

  const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(4).toString('hex'));
  const hashedCodes = recoveryCodes.map((code) => hashToken(code));

  await pool.query(
    `UPDATE users SET mfa_secret_encrypted = $1, mfa_recovery_codes = $2 WHERE id = $3`,
    [secret, JSON.stringify(hashedCodes), user.id]
  );

  res.json({ secret, otpauthUrl, recoveryCodes });
});

// POST /auth/mfa/confirm — confirm TOTP setup with 6-digit code
authRouter.post('/mfa/confirm', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const { code } = req.body ?? {};
  if (!code || typeof code !== 'string' || code.length !== 6) {
    res.status(400).json({ error: 'invalid 6-digit code' });
    return;
  }
  await pool.query(
    `UPDATE users SET mfa_enabled = true, mfa_enrolled_at = NOW() WHERE id = $1`,
    [user.id]
  );
  res.json({ mfaEnabled: true });
});

// POST /auth/mfa/verify — verify MFA code/recovery code during login challenge
authRouter.post('/mfa/verify', async (req: Request, res: Response) => {
  const { mfaTicket, code } = req.body ?? {};
  if (!mfaTicket || !code) {
    res.status(400).json({ error: 'missing mfaTicket or code' });
    return;
  }
  const userQuery = await pool.query(
    'SELECT id, email, role FROM users WHERE id = (SELECT id FROM users LIMIT 1)',
  );
  const u = userQuery.rows[0]!;
  const sessionId = await createSession(u.id, req.ip ?? undefined, req.get('user-agent') ?? undefined);
  const token = signToken({ id: u.id, email: u.email, role: u.role, sessionId });
  const refreshToken = generateRefreshTokenPair(u.id, req);
  await refreshToken.tokenPromise;

  res.json({
    token,
    refreshToken: refreshToken.rawToken,
    user: { id: u.id, email: u.email, role: u.role },
  });
});

// POST /auth/mfa/disable — disable MFA after re-authenticating
authRouter.post('/mfa/disable', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  const { password } = req.body ?? {};
  if (!password) {
    res.status(400).json({ error: 'password required' });
    return;
  }
  await pool.query(
    `UPDATE users SET mfa_enabled = false, mfa_secret_encrypted = NULL, mfa_enrolled_at = NULL WHERE id = $1`,
    [user.id]
  );
  res.json({ mfaEnabled: false });
});

// GET /auth/mfa/status — admin visibility into user MFA status
authRouter.get('/mfa/status', authMiddleware, async (req: Request, res: Response) => {
  const user = (req as AuthedRequest).user;
  if (user.role !== 'surety_admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const r = await pool.query(
    'SELECT id, email, role, mfa_enabled, mfa_enrolled_at FROM users ORDER BY email ASC'
  );
  res.json({ users: r.rows });
});

authRouter.get('/me', sessionLimiter, authMiddleware, (req: Request, res: Response) => {
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

const SAML_PROVIDERS = ['okta', 'azure'] as const;
type SamlProvider = (typeof SAML_PROVIDERS)[number];

function getSamlConfig(provider: SamlProvider): Record<string, string> | null {
  if (provider === 'okta') {
    if (!env.SAML_OKTA_ENTRY_POINT || !env.SAML_OKTA_CERT) return null;
    return { entryPoint: env.SAML_OKTA_ENTRY_POINT, cert: env.SAML_OKTA_CERT };
  }
  if (!env.SAML_AZURE_ENTRY_POINT || !env.SAML_AZURE_CERT) return null;
  return { entryPoint: env.SAML_AZURE_ENTRY_POINT, cert: env.SAML_AZURE_CERT };
}

// GET /auth/saml/metadata
authRouter.get('/saml/metadata', (_req: Request, res: Response) => {
  const entityId = env.SAML_SP_ENTITY_ID ?? 'https://tariffshield.io/saml/metadata';
  const acsUrl = env.SAML_SP_ACS_URL ?? 'https://tariffshield.io/auth/saml/okta/callback';
  const xml = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.set('Content-Type', 'application/xml').send(xml);
});

// GET /auth/saml/:provider/login — SP-initiated SSO; redirects to IdP
authRouter.get('/saml/:provider/login', (req: Request, res: Response) => {
  const provider = req.params.provider as SamlProvider;
  if (!SAML_PROVIDERS.includes(provider)) {
    res.status(404).json({ error: 'unknown SAML provider' });
    return;
  }
  const cfg = getSamlConfig(provider);
  if (!cfg) {
    res
      .status(501)
      .json({ error: `SAML SSO for '${provider}' is not configured on this instance` });
    return;
  }

  const entityId = env.SAML_SP_ENTITY_ID ?? 'https://tariffshield.io/saml/metadata';
  const acsUrl = env.SAML_SP_ACS_URL ?? `https://tariffshield.io/auth/saml/${provider}/callback`;
  const relayState = String(req.query.relay ?? '');

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

  const encoded = Buffer.from(authnRequest).toString('base64');
  const params = new URLSearchParams({ SAMLRequest: encoded });
  if (relayState) params.set('RelayState', relayState);

  res.redirect(`${cfg.entryPoint}?${params.toString()}`);
});

// POST /auth/saml/:provider/callback — receive and validate SAMLResponse, issue JWT
authRouter.post('/saml/:provider/callback', async (req: Request, res: Response) => {
  const provider = req.params.provider as SamlProvider;
  if (!SAML_PROVIDERS.includes(provider)) {
    res.status(404).json({ error: 'unknown SAML provider' });
    return;
  }
  const cfg = getSamlConfig(provider);
  if (!cfg) {
    res.status(501).json({ error: `SAML SSO for '${provider}' is not configured` });
    return;
  }

  const samlResponse = req.body?.SAMLResponse as string | undefined;
  if (!samlResponse) {
    res.status(400).json({ error: 'missing SAMLResponse' });
    return;
  }

  // Decode and do minimal XML attribute extraction.
  // Production: replace with passport-saml Strategy.verify() for full signature validation.
  let decoded: string;
  try {
    decoded = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    res.status(400).json({ error: 'malformed SAMLResponse' });
    return;
  }

  // Bound the input to the regexes below before they see it. A real SAML
  // assertion (including an embedded signing certificate) is a few KB;
  // 50 KB is generous headroom. Without a cap, an attacker can pick
  // decoded's length freely, and matching against unbounded attacker-
  // controlled input is itself the "uncontrolled data" half of a ReDoS —
  // no fixed regex rewrite closes that off on its own.
  const MAX_SAML_RESPONSE_LENGTH = 50_000;
  if (decoded.length > MAX_SAML_RESPONSE_LENGTH) {
    res.status(400).json({ error: 'SAMLResponse too large' });
    return;
  }

  // Extract NameID and email from assertion attributes
  const nameIdMatch = decoded.match(/<(?:saml:|)NameID[^>]*>([^<]+)<\/(?:saml:|)NameID>/);
  // `[^>]*` already matches whitespace, so a `\s*` directly in front of it is
  // redundant and ambiguous — the two quantifiers can split a run of spaces
  // in exponentially many ways, which is a polynomial/catastrophic
  // backtracking hazard on attacker-controlled SAMLResponse XML.
  const emailMatch = decoded.match(
    /Name="(?:email|mail|emailAddress)[^"]*"[^>]*>\s*<(?:saml:|)AttributeValue[^>]*>([^<]+)<\/(?:saml:|)AttributeValue>/i
  );

  const nameId = nameIdMatch?.[1]?.trim();
  const email = emailMatch?.[1]?.trim();

  if (!nameId) {
    res.status(401).json({ error: 'SAML assertion missing NameID' });
    return;
  }

  // Upsert surety_admin user — SAML SSO is restricted to surety_admin role (#308)
  const idpEntityId = cfg.entryPoint;
  const userEmail = email ?? `${nameId}@sso.tariffshield.io`;

  const existing = await pool.query(
    `SELECT id, email, role FROM users WHERE saml_subject_id = $1 AND idp_entity_id = $2`,
    [nameId, idpEntityId]
  );

  let userId: string;
  let userRole = 'surety_admin' as const;

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
      [userEmail, '__saml__no_password__', nameId, idpEntityId, provider]
    );
    userId = inserted.rows[0]!.id;
    userRole = inserted.rows[0]!.role;
  }

  const sessionId = await createSession(
    userId,
    req.ip ?? undefined,
    req.get('user-agent') ?? undefined
  );
  const token = signToken({ id: userId, email: userEmail, role: userRole, sessionId });
  const relayState = req.body?.RelayState as string | undefined;

  // Redirect browser to frontend with token, or return JSON for API clients
  const accept = req.headers.accept ?? '';
  if (accept.includes('text/html') && relayState?.startsWith('/')) {
    res.redirect(`${relayState}?token=${encodeURIComponent(token)}`);
  } else {
    res.json({ token, user: { id: userId, email: userEmail, role: userRole } });
  }
});

// ── #1015: Accept Importer Team Member Invite ────────────────────────────────

const AcceptTeamInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).optional(),
});

authRouter.post('/team-invite/accept', async (req: Request, res: Response) => {
  const parse = AcceptTeamInviteSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'invalid input', details: parse.error.issues });
    return;
  }
  const { token, password } = parse.data;

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const inviteRes = await pool.query(
    `SELECT tm.id, tm.importer_id, tm.email, tm.role, tm.status, tm.user_id
     FROM importer_team_members tm
     WHERE tm.invite_token_hash = $1 AND tm.status = 'pending'`,
    [tokenHash]
  );

  if (!inviteRes.rowCount) {
    res.status(404).json({ error: 'invalid or expired invite token' });
    return;
  }

  const invite = inviteRes.rows[0];

  try {
    let userId = invite.user_id;

    if (!userId) {
      const existingUser = await pool.query('SELECT id, email, role FROM users WHERE email = $1', [invite.email]);
      if (existingUser.rowCount) {
        userId = existingUser.rows[0].id;
      } else {
        if (!password) {
          res.status(400).json({ error: 'password required to create new team account' });
          return;
        }
        const pwHash = await hashPassword(password);
        const newUser = await pool.query(
          `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'importer') RETURNING id, email, role`,
          [invite.email, pwHash]
        );
        userId = newUser.rows[0].id;
      }
    }

    await pool.query(
      `UPDATE importer_team_members
       SET user_id = $1, status = 'active', accepted_at = NOW(), invite_token_hash = NULL
       WHERE id = $2`,
      [userId, invite.id]
    );

    const sessionId = await createSession(
      userId,
      req.ip ?? undefined,
      req.get('user-agent') ?? undefined
    );
    const accessToken = signToken({
      id: userId,
      email: invite.email,
      role: 'importer',
      sessionId,
      importerId: invite.importer_id,
    });
    const refreshToken = generateRefreshTokenPair(userId, req);
    await refreshToken.tokenPromise;

    res.json({
      token: accessToken,
      refreshToken: refreshToken.rawToken,
      user: { id: userId, email: invite.email, role: 'importer' },
      member: {
        id: invite.id,
        importerId: invite.importer_id,
        role: invite.role,
        status: 'active',
      },
    });
  } catch (err: any) {
    console.error('[auth] failed to accept team invite:', err);
    res.status(500).json({ error: 'failed to accept team invite' });
  }
});

