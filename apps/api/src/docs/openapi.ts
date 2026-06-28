/**
 * OpenAPI 3.1 specification for the TariffShield REST API.
 * Served as JSON at GET /docs/openapi.json and rendered via Swagger UI at GET /docs.
 */
export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "TariffShield API",
    version: "0.1.0",
    description:
      "Programmable customs-bond collateral on Stellar. US importers post yield-bearing USDC instead of dead-weight cash; a Soroban smart contract auto-tops-up the bond during tariff spikes.",
    license: { name: "MIT" },
    contact: { name: "TariffShield", url: "https://github.com/vjuliaife/TariffShield" },
  },
  servers: [
    { url: "http://localhost:3002", description: "Local development" },
    { url: "https://tariffshield-api.onrender.com", description: "Render production" },
  ],
  tags: [
    { name: "Auth", description: "Authentication and session management" },
    { name: "Importers", description: "Importer account lifecycle and on-chain collateral operations" },
    { name: "KYC", description: "Know-Your-Customer document submission and review" },
    { name: "Compliance", description: "AML/OFAC flags and periodic compliance reports (surety admin)" },
    { name: "Surety License", description: "Surety license submission and verification workflow" },
    { name: "Health", description: "Liveness and readiness probes" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT issued by POST /auth/login. Required on all protected routes.",
      },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", example: "invalid input" },
          details: { type: "array", items: { type: "object" } },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          role: { type: "string", enum: ["importer", "surety_admin"] },
        },
      },
      Importer: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          legalName: { type: "string" },
          ein: { type: "string", nullable: true },
          bondId: { type: "integer" },
          stellarAddress: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      CollateralStatus: {
        type: "object",
        properties: {
          collateralBalance: { type: "string", description: "Current on-chain collateral (stroops)" },
          requiredCollateral: { type: "string", description: "Required threshold (stroops)" },
          reserveBalance: { type: "string" },
          shortfall: { type: "string", description: "max(0, required − current)" },
          isStale: { type: "boolean" },
          accountFrozen: { type: "boolean" },
        },
      },
      TxResult: {
        type: "object",
        properties: {
          txHash: { type: "string" },
          explorerUrl: { type: "string" },
          collateralBalance: { type: "string" },
        },
      },
      ComplianceFlag: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          importerId: { type: "string", format: "uuid" },
          flagType: { type: "string" },
          severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          status: { type: "string", enum: ["OPEN", "RESOLVED", "ESCALATED"] },
          details: { type: "object" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      SuretyLicenseStatus: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "verified", "rejected"] },
          naicNumber: { type: "string", nullable: true },
          statesLicensed: { type: "array", items: { type: "string" } },
          reviewedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Deep health check",
        description: "Checks Postgres and Soroban RPC connectivity. Returns 503 if any dependency is unhealthy.",
        security: [],
        responses: {
          200: {
            description: "All dependencies healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    db: { type: "string", example: "ok" },
                    soroban: { type: "string", example: "ok" },
                    contractId: { type: "string" },
                    network: { type: "string" },
                  },
                },
              },
            },
          },
          503: { description: "One or more dependencies degraded" },
        },
      },
    },
    "/health/live": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        description: "Returns 200 OK as long as the Node.js process is running.",
        security: [],
        responses: { 200: { description: "Process alive" } },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe",
        description: "Returns 200 only when Postgres and Soroban RPC are reachable.",
        security: [],
        responses: {
          200: { description: "Service ready to handle traffic" },
          503: { description: "Service not yet ready" },
        },
      },
    },
    "/auth/signup": {
      post: {
        tags: ["Auth"],
        summary: "Create account",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 8 },
                  role: { type: "string", enum: ["importer", "surety_admin"], default: "importer" },
                  privacyPolicyVersionId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: "Account created; JWT issued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    user: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
          400: { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Email already registered" },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Authenticate",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: "JWT issued",
            content: {
              "application/json": {
                schema: { type: "object", properties: { token: { type: "string" } } },
              },
            },
          },
          401: { description: "Invalid credentials" },
          429: { description: "Rate-limited (20 attempts per 15 min)" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current user profile",
        responses: {
          200: {
            description: "Authenticated user",
            content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
          },
          401: { description: "Not authenticated" },
        },
      },
    },
    "/auth/saml/metadata": {
      get: {
        tags: ["Auth"],
        summary: "SAML SP metadata",
        description: "Returns the SAML Service Provider metadata XML for IdP configuration.",
        security: [],
        responses: { 200: { description: "XML metadata", content: { "application/xml": {} } } },
      },
    },
    "/auth/saml/{provider}/login": {
      get: {
        tags: ["Auth"],
        summary: "Initiate SAML SSO",
        security: [],
        parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string" } }],
        responses: { 302: { description: "Redirect to IdP" } },
      },
    },
    "/auth/saml/{provider}/callback": {
      post: {
        tags: ["Auth"],
        summary: "SAML assertion callback",
        security: [],
        parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "JWT issued after successful assertion" },
          401: { description: "SAML assertion invalid or user not found" },
        },
      },
    },
    "/importers": {
      post: {
        tags: ["Importers"],
        summary: "Register importer",
        description: "Creates an importer record, generates a Stellar keypair, funds via Friendbot, and calls `register_importer` on-chain. Role must be `importer`.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["legalName", "bondId", "initialRequiredCollateral"],
                properties: {
                  legalName: { type: "string" },
                  ein: { type: "string" },
                  bondId: { type: "integer" },
                  initialRequiredCollateral: { type: "string", pattern: "^\\d+$", description: "In stroops" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "Importer registered", content: { "application/json": { schema: { $ref: "#/components/schemas/Importer" } } } },
          400: { description: "Validation error" },
          403: { description: "Wrong role or OFAC/AML block" },
          409: { description: "Importer already registered for this user" },
        },
      },
      get: {
        tags: ["Importers"],
        summary: "List importers",
        description: "Paginated list of all importers. Surety admin sees all; importer sees only their own record.",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "frozen", "all"] } },
        ],
        responses: {
          200: {
            description: "Importer list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    importers: { type: "array", items: { $ref: "#/components/schemas/Importer" } },
                    total: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/importers/{id}": {
      get: {
        tags: ["Importers"],
        summary: "Get importer",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Importer record", content: { "application/json": { schema: { $ref: "#/components/schemas/Importer" } } } },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/collateral-status": {
      get: {
        tags: ["Importers"],
        summary: "Live collateral health",
        description: "Returns current vs required collateral, reserve balance, shortfall, and staleness flag from the on-chain account state.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Collateral status", content: { "application/json": { schema: { $ref: "#/components/schemas/CollateralStatus" } } } },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/upload-tariff-csv": {
      post: {
        tags: ["Importers"],
        summary: "Upload tariff schedule CSV",
        description: "Parses a CBP-format tariff CSV to recompute `required_collateral`. Validates column headers and duty rates.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "text/csv": { schema: { type: "string" } } },
        },
        responses: {
          200: { description: "Tariff data ingested and required collateral updated" },
          400: { description: "Invalid CSV format or missing required columns" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/deposit": {
      post: {
        tags: ["Importers"],
        summary: "Deposit collateral",
        description: "Builds and submits an on-chain `deposit_collateral` Soroban transaction. Transfers USDC from the importer's wallet into the contract escrow.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: { amount: { type: "string", pattern: "^\\d+$", description: "Amount in stroops" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Deposit submitted", content: { "application/json": { schema: { $ref: "#/components/schemas/TxResult" } } } },
          400: { description: "Invalid amount or insufficient balance" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/auto-top-up": {
      post: {
        tags: ["Importers"],
        summary: "Trigger auto top-up",
        description: "Calls `auto_top_up` on-chain — moves `min(shortfall, reserve)` from reserve to collateral. Can be called by anyone when a shortfall exists.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Top-up submitted", content: { "application/json": { schema: { $ref: "#/components/schemas/TxResult" } } } },
          400: { description: "No shortfall or insufficient reserve" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/withdraw": {
      post: {
        tags: ["Importers"],
        summary: "Withdraw collateral",
        description: "Returns escrowed USDC to the importer after verifying the bond is in good standing.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["amount"],
                properties: { amount: { type: "string" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Withdrawal submitted", content: { "application/json": { schema: { $ref: "#/components/schemas/TxResult" } } } },
          400: { description: "Insufficient collateral or bond not in good standing" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/accrue-yield": {
      post: {
        tags: ["Importers"],
        summary: "Accrue yield (surety admin)",
        description: "Triggers `accrue_yield` on-chain for the importer. Requires `surety_admin` role with a verified license.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["yieldAmount"],
                properties: { yieldAmount: { type: "string", description: "Yield amount in stroops" } },
              },
            },
          },
        },
        responses: {
          200: { description: "Yield accrued on-chain" },
          403: { description: "Role or license verification check failed" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/clawback": {
      post: {
        tags: ["Importers"],
        summary: "Emergency clawback (surety admin)",
        description: "Executes the `clawback` Soroban entrypoint. Drains both collateral and reserve buckets to the surety wallet and freezes the importer account. Irreversible. Requires `surety_admin` role with a verified license.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["reason"],
                properties: {
                  reason: { type: "string", description: "Legal justification recorded in the audit log" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Clawback executed; audit log entry created" },
          403: { description: "Role or license check failed" },
          404: { description: "Importer not found" },
          409: { description: "Account already frozen" },
        },
      },
    },
    "/importers/{id}/kyc": {
      post: {
        tags: ["KYC"],
        summary: "Submit KYC documents",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["documentType", "documentNumber"],
                properties: {
                  documentType: { type: "string", enum: ["passport", "ein_letter", "articles_of_incorporation"] },
                  documentNumber: { type: "string" },
                  issuingCountry: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "KYC record created" },
          404: { description: "Importer not found" },
        },
      },
      get: {
        tags: ["KYC"],
        summary: "Get KYC status",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "KYC status and submitted document list" },
          404: { description: "Importer not found" },
        },
      },
    },
    "/importers/{id}/kyc/{docId}/download": {
      get: {
        tags: ["KYC"],
        summary: "Download KYC document",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "docId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Document binary" },
          404: { description: "Document not found" },
        },
      },
    },
    "/compliance/dashboard": {
      get: {
        tags: ["Compliance"],
        summary: "Compliance dashboard",
        description: "Aggregated AML/OFAC flag counts and recent incidents. Surety admin only.",
        responses: {
          200: { description: "Dashboard data" },
          403: { description: "Insufficient role" },
        },
      },
      delete: {
        tags: ["Compliance"],
        summary: "Clear dashboard cache",
        responses: { 204: { description: "Cache cleared" }, 403: { description: "Insufficient role" } },
      },
    },
    "/compliance/flags": {
      get: {
        tags: ["Compliance"],
        summary: "List compliance flags",
        description: "Paginated list of AML/OFAC/sanctions flags. Surety admin only.",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["OPEN", "RESOLVED", "ESCALATED"] } },
          { name: "severity", in: "query", schema: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        ],
        responses: {
          200: {
            description: "Flag list",
            content: { "application/json": { schema: { type: "object", properties: { flags: { type: "array", items: { $ref: "#/components/schemas/ComplianceFlag" } }, total: { type: "integer" } } } } },
          },
          403: { description: "Insufficient role" },
        },
      },
    },
    "/compliance/flags/{id}/resolve": {
      post: {
        tags: ["Compliance"],
        summary: "Resolve a compliance flag",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["resolution"],
                properties: {
                  resolution: { type: "string" },
                  newStatus: { type: "string", enum: ["RESOLVED", "ESCALATED"] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Flag updated" },
          403: { description: "Insufficient role" },
          404: { description: "Flag not found" },
        },
      },
    },
    "/compliance/reports": {
      get: {
        tags: ["Compliance"],
        summary: "List compliance reports",
        responses: {
          200: { description: "Generated compliance report list" },
          403: { description: "Insufficient role" },
        },
      },
    },
    "/compliance/reports/{id}/download": {
      get: {
        tags: ["Compliance"],
        summary: "Download compliance report",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          200: { description: "Report file (PDF or CSV)" },
          404: { description: "Report not found" },
        },
      },
    },
    "/surety-license/submit": {
      post: {
        tags: ["Surety License"],
        summary: "Submit license credentials",
        description: "Surety admin submits NAIC number and state licensing data for platform review.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["naicNumber", "statesLicensed"],
                properties: {
                  naicNumber: { type: "string" },
                  statesLicensed: { type: "array", items: { type: "string", pattern: "^[A-Z]{2}$" } },
                  licenseExpiryDate: { type: "string", format: "date" },
                },
              },
            },
          },
        },
        responses: {
          201: { description: "License record created; pending review" },
          403: { description: "Not a surety admin account" },
        },
      },
    },
    "/surety-license/status": {
      get: {
        tags: ["Surety License"],
        summary: "Get own license status",
        responses: {
          200: { description: "License verification status", content: { "application/json": { schema: { $ref: "#/components/schemas/SuretyLicenseStatus" } } } },
          403: { description: "Not a surety admin account" },
        },
      },
    },
    "/surety-license/{id}/review": {
      put: {
        tags: ["Surety License"],
        summary: "Review license (platform admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["decision"],
                properties: {
                  decision: { type: "string", enum: ["verified", "rejected"] },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "License status updated" },
          404: { description: "License record not found" },
        },
      },
    },
    "/surety-license": {
      get: {
        tags: ["Surety License"],
        summary: "List all license records (platform admin)",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "verified", "rejected"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        ],
        responses: {
          200: { description: "Paginated license records" },
          403: { description: "Not a platform admin" },
        },
      },
    },
  },
} as const;
