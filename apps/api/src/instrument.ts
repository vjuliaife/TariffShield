import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || "development",
  tracesSampleRate: 0.1,
  profilesSampleRate: 1.0,
  integrations: [
    nodeProfilingIntegration(),
  ],
  release: process.env.VERCEL_GIT_COMMIT_SHA || process.env.SENTRY_RELEASE,
});
