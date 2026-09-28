/**
 * OpenAPI 3.1 specification for the TariffShield REST API.
 * Served as JSON at GET /docs/openapi.json and rendered via Swagger UI at GET /docs.
 */
export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'TariffShield API',
    version: '0.1.0',
    description:
      'Programmable customs-bond collateral on Stellar. US importers post yield-bearing USDC instead of dead-weight cash; a Soroban smart contract auto-tops-up the bond during tariff spikes.',
    license: { name: 'MIT' },
    contact: { name: 'TariffShield', url: 'https://github.com/vjuliaife/TariffShield' },
  },
  servers: [
    { url: 'http://localhost:3002', description: 'Local development' },
    { url: 'https://tariffshield-api.onrender.com', description: 'Render production' },
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and session management' },
    {
      name: 'Importers',
      description: 'Importer account lifecycle and on-chain collateral operations',
    },
    { name: 'KYC', description: 'Know-Your-Customer document submission and review' },
    { name: 'Credit Lines', description: 'Importer credit-line pre-approvals (#1007)' },
    { name: 'Disputes', description: 'Collateral dispute recommendations and resolution (#1008)' },
    { name: 'Approvals', description: 'Configurable multi-step surety approval chains (#1009)' },
    {
      name: 'Compliance',
      description: 'AML/OFAC flags and periodic compliance reports (surety admin)',
    },
    { name: 'Surety License', description: 'Surety license submission and verification workflow' },
    { name: 'Health', description: 'Liveness and readiness probes' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT issued by POST /auth/login. Required on all protected routes.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string', example: 'invalid input' },
          target: {
            type: 'string',
            enum: ['body', 'query'],
            description: 'On validation failures, which part of the request failed schema validation',
          },
          details: { type: 'array', items: { type: 'object' } },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['importer', 'surety_admin'] },
        },
      },
      Importer: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          legalName: { type: 'string' },
          ein: { type: 'string', nullable: true },
          bondId: { type: 'integer' },
          stellarAddress: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CollateralStatus: {
        type: 'object',
        properties: {
          collateralBalance: {
            type: 'string',
            description: 'Current on-chain collateral (stroops)',
          },
          requiredCollateral: { type: 'string', description: 'Required threshold (stroops)' },
          reserveBalance: { type: 'string' },
          shortfall: { type: 'string', description: 'max(0, required − current)' },
          isStale: { type: 'boolean' },
          accountFrozen: { type: 'boolean' },
        },
      },
      TxResult: {
        type: 'object',
        properties: {
          txHash: { type: 'string' },
          explorerUrl: { type: 'string' },
          collateralBalance: { type: 'string' },
        },
      },
      ComplianceFlag: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          importerId: { type: 'string', format: 'uuid' },
          flagType: { type: 'string' },
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          status: { type: 'string', enum: ['OPEN', 'RESOLVED', 'ESCALATED'] },
          details: { type: 'object' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SuretyLicenseStatus: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
          naicNumber: { type: 'string', nullable: true },
          statesLicensed: { type: 'array', items: { type: 'string' } },
          reviewedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Deep health check',
        description:
          'Checks Postgres and Soroban RPC connectivity. Returns 503 if any dependency is unhealthy.',
        security: [],
        responses: {
          200: {
            description: 'All dependencies healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    db: { type: 'string', example: 'ok' },
                    soroban: { type: 'string', example: 'ok' },
                    contractId: { type: 'string' },
                    network: { type: 'string' },
                  },
                },
              },
            },
          },
          503: { description: 'One or more dependencies degraded' },
        },
      },
    },
    '/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description:
          'Returns 200 with `{ "status": "ok" }` as long as the Node.js process is running.',
        security: [],
        responses: { 200: { description: 'Process alive — `{ "status": "ok" }`' } },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description:
          'Returns 200 only when Postgres, Soroban RPC and Redis are reachable. The body is `{ "status": "ok" }` on success and `{ "status": "degraded" }` on 503.',
        security: [],
        responses: {
          200: { description: 'Service ready to handle traffic — `{ "status": "ok" }`' },
          503: { description: 'Service not yet ready — `{ "status": "degraded" }`' },
        },
      },
    },
    '/auth/signup': {
      post: {
        tags: ['Auth'],
        summary: 'Create account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  role: { type: 'string', enum: ['importer', 'surety_admin'], default: 'importer' },
                  privacyPolicyVersionId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Account created; JWT issued',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string' },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          409: { description: 'Email already registered' },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'JWT issued',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { token: { type: 'string' } } },
              },
            },
          },
          401: { description: 'Invalid credentials' },
          429: { description: 'Rate-limited (20 attempts per 15 min)' },
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user profile',
        responses: {
          200: {
            description: 'Authenticated user',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          401: { description: 'Not authenticated' },
        },
      },
    },
    '/auth/saml/metadata': {
      get: {
        tags: ['Auth'],
        summary: 'SAML SP metadata',
        description: 'Returns the SAML Service Provider metadata XML for IdP configuration.',
        security: [],
        responses: { 200: { description: 'XML metadata', content: { 'application/xml': {} } } },
      },
    },
    '/auth/saml/{provider}/login': {
      get: {
        tags: ['Auth'],
        summary: 'Initiate SAML SSO',
        security: [],
        parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 302: { description: 'Redirect to IdP' } },
      },
    },
    '/auth/saml/{provider}/callback': {
      post: {
        tags: ['Auth'],
        summary: 'SAML assertion callback',
        security: [],
        parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'JWT issued after successful assertion' },
          401: { description: 'SAML assertion invalid or user not found' },
        },
      },
    },
    '/importers': {
      post: {
        tags: ['Importers'],
        summary: 'Register importer',
        description:
          'Creates an importer record, generates a Stellar keypair, funds via Friendbot, and calls `register_importer` on-chain. Role must be `importer`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['legalName', 'bondId', 'initialRequiredCollateral'],
                properties: {
                  legalName: { type: 'string' },
                  ein: { type: 'string' },
                  bondId: { type: 'integer' },
                  initialRequiredCollateral: {
                    type: 'string',
                    pattern: '^\\d+$',
                    description: 'In stroops',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Importer registered',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Importer' } } },
          },
          400: { description: 'Validation error' },
          403: { description: 'Wrong role or OFAC/AML block' },
          409: { description: 'Importer already registered for this user' },
        },
      },
      get: {
        tags: ['Importers'],
        summary: 'List importers',
        description:
          'Paginated list of all importers. Surety admin sees all; importer sees only their own record.',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'frozen', 'all'] },
          },
        ],
        responses: {
          200: {
            description: 'Importer list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    importers: { type: 'array', items: { $ref: '#/components/schemas/Importer' } },
                    total: { type: 'integer' },
                    page: { type: 'integer' },
                    limit: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/importers/{id}': {
      get: {
        tags: ['Importers'],
        summary: 'Get importer',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Importer record',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Importer' } } },
          },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/collateral-status': {
      get: {
        tags: ['Importers'],
        summary: 'Live collateral health',
        description:
          'Returns current vs required collateral, reserve balance, shortfall, and staleness flag from the on-chain account state.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Collateral status',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CollateralStatus' } },
            },
          },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/upload-tariff-csv': {
      post: {
        tags: ['Importers'],
        summary: 'Upload tariff schedule CSV',
        description:
          'Parses a CBP-format tariff CSV to recompute `required_collateral`. Validates column headers and duty rates.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: { 'text/csv': { schema: { type: 'string' } } },
        },
        responses: {
          200: { description: 'Tariff data ingested and required collateral updated' },
          400: { description: 'Invalid CSV format or missing required columns' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/deposit': {
      post: {
        tags: ['Importers'],
        summary: 'Deposit collateral',
        description:
          "Builds and submits an on-chain `deposit_collateral` Soroban transaction. Transfers USDC from the importer's wallet into the contract escrow.",
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                properties: {
                  amount: { type: 'string', pattern: '^\\d+$', description: 'Amount in stroops' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Deposit submitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TxResult' } } },
          },
          400: { description: 'Invalid amount or insufficient balance' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/auto-top-up': {
      post: {
        tags: ['Importers'],
        summary: 'Trigger auto top-up',
        description:
          'Calls `auto_top_up` on-chain — moves `min(shortfall, reserve)` from reserve to collateral. Can be called by anyone when a shortfall exists.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Top-up submitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TxResult' } } },
          },
          400: { description: 'No shortfall or insufficient reserve' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/withdraw': {
      post: {
        tags: ['Importers'],
        summary: 'Withdraw collateral',
        description:
          'Returns escrowed USDC to the importer after verifying the bond is in good standing.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount'],
                properties: { amount: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Withdrawal submitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TxResult' } } },
          },
          400: { description: 'Insufficient collateral or bond not in good standing' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/accrue-yield': {
      post: {
        tags: ['Importers'],
        summary: 'Accrue yield (surety admin)',
        description:
          'Triggers `accrue_yield` on-chain for the importer. Requires `surety_admin` role with a verified license.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['yieldAmount'],
                properties: {
                  yieldAmount: { type: 'string', description: 'Yield amount in stroops' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Yield accrued on-chain' },
          403: { description: 'Role or license verification check failed' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/clawback': {
      post: {
        tags: ['Importers'],
        summary: 'Emergency clawback (surety admin)',
        description:
          'Executes the `clawback` Soroban entrypoint. Drains both collateral and reserve buckets to the surety wallet and freezes the importer account. Irreversible. Requires `surety_admin` role with a verified license.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['reason'],
                properties: {
                  reason: {
                    type: 'string',
                    description: 'Legal justification recorded in the audit log',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Clawback executed; audit log entry created' },
          403: { description: 'Role or license check failed' },
          404: { description: 'Importer not found' },
          409: { description: 'Account already frozen' },
        },
      },
    },
    '/importers/{id}/kyc': {
      post: {
        tags: ['KYC'],
        summary: 'Submit KYC documents',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['documentType', 'documentNumber'],
                properties: {
                  documentType: {
                    type: 'string',
                    enum: ['passport', 'ein_letter', 'articles_of_incorporation'],
                  },
                  documentNumber: { type: 'string' },
                  issuingCountry: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'KYC record created' },
          404: { description: 'Importer not found' },
        },
      },
      get: {
        tags: ['KYC'],
        summary: 'Get KYC status',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'KYC status and submitted document list' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/importers/{id}/kyc/{docId}/download': {
      get: {
        tags: ['KYC'],
        summary: 'Download KYC document',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'docId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Document binary' },
          404: { description: 'Document not found' },
        },
      },
    },
    '/importers/{id}/kyc/batch': {
      post: {
        tags: ['KYC'],
        summary: 'Bulk drag-and-drop KYC document upload (#1006)',
        description:
          'Accepts up to 10 files in one request. Each file is processed individually; per-file status is success, failed or virus-scan-pending. The single-file POST /importers/{id}/kyc endpoint remains supported.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['documents'],
                properties: {
                  documents: {
                    type: 'array',
                    maxItems: 10,
                    items: {
                      type: 'object',
                      required: ['documentType', 'fileBase64', 'mimeType'],
                      properties: {
                        documentType: {
                          type: 'string',
                          enum: [
                            'articles_of_incorporation',
                            'ein_confirmation',
                            'beneficial_ownership_fincen_102',
                          ],
                        },
                        fileBase64: { type: 'string' },
                        mimeType: {
                          type: 'string',
                          enum: ['application/pdf', 'image/png', 'image/jpeg'],
                        },
                        fileName: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description:
              'Per-file results: { results: [{ index, fileName, documentType, status, virusScanStatus, document?, error? }], succeeded, failed, pending }',
          },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/admin/credit-lines': {
      get: {
        tags: ['Credit Lines'],
        summary: 'List credit lines (#1007)',
        parameters: [
          { name: 'importer_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['active', 'expired', 'revoked'] },
          },
        ],
        responses: {
          200: { description: '{ creditLines: [...] }' },
          403: { description: 'Insufficient role' },
        },
      },
      post: {
        tags: ['Credit Lines'],
        summary: 'Grant a time-boxed credit line to an importer (#1007)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['importerId', 'amount'],
                properties: {
                  importerId: { type: 'string', format: 'uuid' },
                  amount: { type: 'string', description: 'stroops (integer string)' },
                  expiresAt: { type: 'string', format: 'date-time' },
                  durationHours: { type: 'integer', minimum: 1 },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: '{ creditLine }' },
          400: { description: 'invalid input' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/admin/credit-lines/{id}/revoke': {
      post: {
        tags: ['Credit Lines'],
        summary: 'Revoke an active credit line (#1007)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: '{ creditLine }' },
          404: { description: 'Active credit line not found' },
        },
      },
    },
    '/importers/{id}/collateral-health': {
      get: {
        tags: ['Credit Lines'],
        summary: 'Credit-line-aware collateral health check (#1007)',
        description:
          'Active credit lines count as temporary coverage of any shortfall; expired or revoked lines are excluded so the strict requirement applies again.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: '{ health, strict }' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/admin/disputes': {
      get: {
        tags: ['Disputes'],
        summary: 'List open collateral disputes (#1008)',
        responses: {
          200: { description: '{ disputes: [...] }' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/admin/disputes/{importerId}/recommendation': {
      get: {
        tags: ['Disputes'],
        summary: 'Advisory dispute-resolution recommendation (#1008)',
        description:
          'Suggests accept/reject with supporting factors. Advisory only — never resolves the dispute. See docs/dispute-recommendation.md.',
        parameters: [
          {
            name: 'importerId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: { description: '{ recommendation }' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/admin/disputes/{id}/resolve': {
      post: {
        tags: ['Disputes'],
        summary: 'Explicitly resolve a dispute on-chain (#1008)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['accept'],
                properties: {
                  accept: {
                    type: 'boolean',
                    description: 'true = keep new requirement; false = revert to pre-dispute',
                  },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '{ dispute, txUrl }' },
          404: { description: 'Dispute not found' },
          409: { description: 'Dispute is not open' },
        },
      },
    },
    '/importers/admin/approval-chains': {
      get: {
        tags: ['Approvals'],
        summary: 'List approval chain versions (#1009)',
        responses: {
          200: { description: '{ chains: [...] }' },
          403: { description: 'Insufficient role' },
        },
      },
      post: {
        tags: ['Approvals'],
        summary: 'Create the next version of an approval chain (#1009)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'steps'],
                properties: {
                  name: { type: 'string' },
                  steps: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['name', 'requiredRole'],
                      properties: {
                        name: { type: 'string' },
                        requiredRole: {
                          type: 'string',
                          enum: ['underwriter', 'compliance_officer', 'surety_admin'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: '{ chain }' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/importers/admin/{id}/review/start': {
      post: {
        tags: ['Approvals'],
        summary: 'Start a multi-step review chain for an importer (#1009)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          201: { description: '{ approval }' },
          400: { description: 'No active approval chain configured' },
          409: { description: 'A review is already in progress' },
        },
      },
    },
    '/importers/admin/{id}/review/decision': {
      post: {
        tags: ['Approvals'],
        summary: 'Record the current approval step decision (#1009)',
        description:
          'Each step must be approved by a different surety admin. Approval finalises only when every step approves; any rejection halts the chain and notifies the importer.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['approved', 'rejected'] },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: '{ approval, finalized, halted, importerKycStatus }' },
          403: { description: 'Same approver cannot decide two steps' },
          404: { description: 'No review in progress' },
        },
      },
    },
    '/importers/admin/{id}/review': {
      get: {
        tags: ['Approvals'],
        summary: 'Single-query importer review + approval chain state (#244, #1009)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: '{ review, approval }' },
          404: { description: 'Importer not found' },
        },
      },
    },
    '/compliance/dashboard': {
      get: {
        tags: ['Compliance'],
        summary: 'Compliance dashboard',
        description: 'Aggregated AML/OFAC flag counts and recent incidents. Surety admin only.',
        responses: {
          200: { description: 'Dashboard data' },
          403: { description: 'Insufficient role' },
        },
      },
      delete: {
        tags: ['Compliance'],
        summary: 'Clear dashboard cache',
        responses: {
          204: { description: 'Cache cleared' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/compliance/flags': {
      get: {
        tags: ['Compliance'],
        summary: 'List compliance flags',
        description: 'Paginated list of AML/OFAC/sanctions flags. Surety admin only.',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['OPEN', 'RESOLVED', 'ESCALATED'] },
          },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: {
          200: {
            description: 'Flag list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    flags: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ComplianceFlag' },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/compliance/flags/{id}/resolve': {
      post: {
        tags: ['Compliance'],
        summary: 'Resolve a compliance flag',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['resolution'],
                properties: {
                  resolution: { type: 'string' },
                  newStatus: { type: 'string', enum: ['RESOLVED', 'ESCALATED'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Flag updated' },
          403: { description: 'Insufficient role' },
          404: { description: 'Flag not found' },
        },
      },
    },
    '/compliance/reports': {
      get: {
        tags: ['Compliance'],
        summary: 'List compliance reports',
        responses: {
          200: { description: 'Generated compliance report list' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/compliance/reports/{id}/download': {
      get: {
        tags: ['Compliance'],
        summary: 'Download compliance report',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Report file (PDF or CSV)' },
          404: { description: 'Report not found' },
        },
      },
    },
    '/compliance/report-schedules': {
      get: {
        tags: ['Compliance'],
        summary: 'List scheduled report deliveries',
        responses: {
          200: { description: 'Report schedules for this surety' },
          403: { description: 'Insufficient role' },
        },
      },
      post: {
        tags: ['Compliance'],
        summary: 'Create a scheduled report delivery',
        description:
          'Generates the report type on a weekly (Mondays) or monthly (1st) cadence at 06:00 UTC and emails each recipient a unique, expiring download link. Failed sends are retried with backoff.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  report_type: { type: 'string', enum: ['compliance_summary'] },
                  cadence: { type: 'string', enum: ['weekly', 'monthly'] },
                  recipients: {
                    type: 'array',
                    items: { type: 'string', format: 'email' },
                    minItems: 1,
                    maxItems: 20,
                  },
                },
                required: ['report_type', 'cadence', 'recipients'],
              },
            },
          },
        },
        responses: {
          201: { description: 'Schedule created' },
          400: { description: 'Invalid input' },
          403: { description: 'Insufficient role' },
        },
      },
    },
    '/compliance/report-schedules/{id}': {
      put: {
        tags: ['Compliance'],
        summary: 'Edit, pause or resume a report schedule',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  report_type: { type: 'string', enum: ['compliance_summary'] },
                  cadence: { type: 'string', enum: ['weekly', 'monthly'] },
                  recipients: {
                    type: 'array',
                    items: { type: 'string', format: 'email' },
                    minItems: 1,
                    maxItems: 20,
                  },
                  is_paused: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Schedule updated' },
          400: { description: 'Invalid input' },
          404: { description: 'Schedule not found' },
        },
      },
      delete: {
        tags: ['Compliance'],
        summary: 'Delete a report schedule',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Schedule deleted; previously generated reports are kept' },
          404: { description: 'Schedule not found' },
        },
      },
    },
    '/compliance/report-schedules/{id}/deliveries': {
      get: {
        tags: ['Compliance'],
        summary: 'Delivery log for a report schedule',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['pending', 'sent', 'failed'] },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'Deliveries with attempt count and last error' },
          404: { description: 'Schedule not found' },
        },
      },
    },
    '/compliance-report-links/{token}': {
      get: {
        tags: ['Compliance'],
        summary: 'Open an emailed report download link',
        description:
          'Unauthenticated; the token is the credential. Redirects to a short-lived pre-signed report URL.',
        security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          302: { description: 'Redirect to the report PDF' },
          404: { description: 'Link unknown, expired, or report PDF unavailable' },
        },
      },
    },
    '/surety-license/submit': {
      post: {
        tags: ['Surety License'],
        summary: 'Submit license credentials',
        description:
          'Surety admin submits NAIC number and state licensing data for platform review.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['naicNumber', 'statesLicensed'],
                properties: {
                  naicNumber: { type: 'string' },
                  statesLicensed: {
                    type: 'array',
                    items: { type: 'string', pattern: '^[A-Z]{2}$' },
                  },
                  licenseExpiryDate: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'License record created; pending review' },
          403: { description: 'Not a surety admin account' },
        },
      },
    },
    '/surety-license/status': {
      get: {
        tags: ['Surety License'],
        summary: 'Get own license status',
        responses: {
          200: {
            description: 'License verification status',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SuretyLicenseStatus' } },
            },
          },
          403: { description: 'Not a surety admin account' },
        },
      },
    },
    '/surety-license/{id}/review': {
      put: {
        tags: ['Surety License'],
        summary: 'Review license (platform admin)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['verified', 'rejected'] },
                  notes: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'License status updated' },
          404: { description: 'License record not found' },
        },
      },
    },
    '/surety-license': {
      get: {
        tags: ['Surety License'],
        summary: 'List all license records (platform admin)',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['pending', 'verified', 'rejected'] },
          },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        ],
        responses: {
          200: { description: 'Paginated license records' },
          403: { description: 'Not a platform admin' },
        },
      },
    },
  },
} as const;
