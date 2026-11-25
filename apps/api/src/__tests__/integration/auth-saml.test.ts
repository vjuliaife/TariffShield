/**
 * Integration coverage for SAML 2.0 SSO endpoints (#576):
 * - GET /auth/saml/:provider/login returns 501 when IdP env vars are unset
 * - GET /auth/saml/:provider/login returns 404 for unknown provider
 * - GET /auth/saml/:provider/login returns 302 redirect when IdP env vars are configured
 * - GET /auth/saml/metadata returns 200 XML regardless of provider configuration
 *
 * Run via: npm run test:integration --workspace=apps/api
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

function stub(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

stub('DATABASE_URL', 'postgres://test:test@localhost:5432/tariffshield_test');
stub('JWT_SECRET', 'test-stub-jwt-secret-not-used-by-this-suite-00000');
stub('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
stub('STELLAR_HORIZON_URL', 'https://horizon-testnet.stellar.org');
stub('STELLAR_NETWORK_PASSPHRASE', 'Test SDF Network ; September 2015');
stub('TARIFF_SHIELD_CONTRACT_ID', 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
stub('PLATFORM_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB');
stub('SURETY_STELLAR_SECRET', 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC');

const { env } = await import('../../config/env.js');
const { authRouter } = await import('../../routes/auth.js');

let serverUrl: string;

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
const server = createServer(app);

describe('Issue #576: SAML 2.0 SSO Integration Suite', () => {
  let originalOktaEntryPoint: string | undefined;
  let originalOktaCert: string | undefined;
  let originalAzureEntryPoint: string | undefined;
  let originalAzureCert: string | undefined;

  before(async () => {
    // Preserve any existing SAML configuration
    originalOktaEntryPoint = env.SAML_OKTA_ENTRY_POINT;
    originalOktaCert = env.SAML_OKTA_CERT;
    originalAzureEntryPoint = env.SAML_AZURE_ENTRY_POINT;
    originalAzureCert = env.SAML_AZURE_CERT;

    // Ensure SAML env vars start unset for default unconfigured tests
    delete env.SAML_OKTA_ENTRY_POINT;
    delete env.SAML_OKTA_CERT;
    delete env.SAML_AZURE_ENTRY_POINT;
    delete env.SAML_AZURE_CERT;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    server.close();

    // Restore original SAML configuration
    if (originalOktaEntryPoint) env.SAML_OKTA_ENTRY_POINT = originalOktaEntryPoint;
    else delete env.SAML_OKTA_ENTRY_POINT;

    if (originalOktaCert) env.SAML_OKTA_CERT = originalOktaCert;
    else delete env.SAML_OKTA_CERT;

    if (originalAzureEntryPoint) env.SAML_AZURE_ENTRY_POINT = originalAzureEntryPoint;
    else delete env.SAML_AZURE_ENTRY_POINT;

    if (originalAzureCert) env.SAML_AZURE_CERT = originalAzureCert;
    else delete env.SAML_AZURE_CERT;
  });

  it('GET /auth/saml/okta/login returns 501 when IdP env vars are unset', async () => {
    const res = await fetch(`${serverUrl}/auth/saml/okta/login`, {
      redirect: 'manual',
      headers: { connection: 'close' },
    });

    assert.equal(res.status, 501);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "SAML SSO for 'okta' is not configured on this instance");
  });

  it('GET /auth/saml/azure/login returns 501 when Azure IdP env vars are unset', async () => {
    const res = await fetch(`${serverUrl}/auth/saml/azure/login`, {
      redirect: 'manual',
      headers: { connection: 'close' },
    });

    assert.equal(res.status, 501);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "SAML SSO for 'azure' is not configured on this instance");
  });

  it('GET /auth/saml/unknown-provider/login returns 404 for unknown provider', async () => {
    const res = await fetch(`${serverUrl}/auth/saml/unknown-provider/login`, {
      redirect: 'manual',
      headers: { connection: 'close' },
    });

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.deepEqual(body, { error: 'unknown SAML provider' });
  });

  it('GET /auth/saml/okta/login returns 302 redirect with AuthnRequest when IdP env vars are configured', async () => {
    const mockEntryPoint = 'https://login.okta.com/app/tariffshield/exk123456/sso/saml';
    const mockCert = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0TestCertificateContent';

    env.SAML_OKTA_ENTRY_POINT = mockEntryPoint;
    env.SAML_OKTA_CERT = mockCert;

    try {
      const res = await fetch(`${serverUrl}/auth/saml/okta/login`, {
        redirect: 'manual',
        headers: { connection: 'close' },
      });

      assert.equal(res.status, 302, 'Expected 302 redirect');
      const location = res.headers.get('location');
      assert.ok(location, 'Expected location header in redirect response');
      assert.ok(
        location.startsWith(mockEntryPoint),
        `Location header should start with entry point: ${location}`
      );

      // Verify AuthnRequest query parameter
      const redirectUrl = new URL(location);
      const samlRequestParam = redirectUrl.searchParams.get('SAMLRequest');
      assert.ok(samlRequestParam, 'Expected SAMLRequest query parameter in redirect URL');

      const decodedAuthnRequest = Buffer.from(samlRequestParam, 'base64').toString('utf8');
      assert.ok(
        decodedAuthnRequest.includes('<samlp:AuthnRequest'),
        'Expected decoded SAMLRequest to contain AuthnRequest XML'
      );
      assert.ok(
        decodedAuthnRequest.includes('<saml:Issuer>'),
        'Expected decoded SAMLRequest to contain Issuer XML tag'
      );
    } finally {
      delete env.SAML_OKTA_ENTRY_POINT;
      delete env.SAML_OKTA_CERT;
    }
  });

  it('GET /auth/saml/okta/login includes RelayState parameter in redirect when relay query parameter is passed', async () => {
    const mockEntryPoint = 'https://login.okta.com/app/tariffshield/exk123456/sso/saml';
    const mockCert = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0TestCertificateContent';

    env.SAML_OKTA_ENTRY_POINT = mockEntryPoint;
    env.SAML_OKTA_CERT = mockCert;

    try {
      const relayUrl = 'https://app.tariffshield.com/dashboard/bonds';
      const res = await fetch(
        `${serverUrl}/auth/saml/okta/login?relay=${encodeURIComponent(relayUrl)}`,
        {
          redirect: 'manual',
          headers: { connection: 'close' },
        }
      );

      assert.equal(res.status, 302);
      const location = res.headers.get('location');
      assert.ok(location);
      const redirectUrl = new URL(location);
      assert.equal(redirectUrl.searchParams.get('RelayState'), relayUrl);
    } finally {
      delete env.SAML_OKTA_ENTRY_POINT;
      delete env.SAML_OKTA_CERT;
    }
  });

  it('GET /auth/saml/metadata returns 200 with XML content type regardless of provider configuration', async () => {
    // Verify when SAML providers are NOT configured
    delete env.SAML_OKTA_ENTRY_POINT;
    delete env.SAML_OKTA_CERT;

    const res = await fetch(`${serverUrl}/auth/saml/metadata`, {
      headers: { connection: 'close' },
    });

    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType, 'Expected content-type header');
    assert.ok(
      contentType.includes('application/xml'),
      `Content-Type must be application/xml, got: ${contentType}`
    );

    const xmlText = await res.text();
    assert.ok(xmlText.includes('<?xml version="1.0"?>'));
    assert.ok(xmlText.includes('<EntityDescriptor'));
    assert.ok(xmlText.includes('<SPSSODescriptor'));
    assert.ok(xmlText.includes('<AssertionConsumerService'));
  });
});
