/**
 * ShadowVox - Sentry Instrumentation
 *
 * ⚠️  This module MUST be imported FIRST in src/index.ts,
 *     before any other imports, to ensure Sentry captures
 *     all errors from the very start of the application.
 *
 * Reads SENTRY_DSN from the environment. If it's not set,
 * Sentry is disabled with a warning — no crash, no spam.
 */

import * as Sentry from "@sentry/node";

const dsn = process.env.SENTRY_DSN;

// Validate critical environment config at startup
const requiredVars = ["DISCORD_BOT_TOKEN"];
for (const varName of requiredVars) {
  if (!process.env[varName] || (process.env[varName]?.length ?? 0) < 10) {
    console.error(`❌ CRITICAL: ${varName} is missing or too short in .env`);
    console.error(
      `   Copy .env.example to .env and fill in all required values.`,
    );
    process.exit(1);
  }
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    // Capture console.error/warn as breadcrumbs automatically
    integrations: [],
    // Default integrations include context for Node.js v8+
  });

  console.log("📡 Sentry error tracking initialized");
} else {
  console.warn(
    "⚠️  SENTRY_DSN not set — error tracking disabled. " +
      "Set it in .env to enable Sentry.",
  );
}

export default Sentry;
