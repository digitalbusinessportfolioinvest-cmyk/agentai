#!/usr/bin/env node
/**
 * Runs `prisma migrate deploy` only if DATABASE_URL is set.
 * Railway: add DATABASE_URL to the *same* service as the app (Reference → Postgres).
 */
const { execSync } = require('child_process');

const url = process.env.DATABASE_URL;
if (!url || !String(url).trim()) {
  console.error('\n[AgentAi] DATABASE_URL is missing or empty.\n');
  console.error('Fix on Railway:');
  console.error('  1. Open your Node / web service (the one running this app) — not only the Postgres card.');
  console.error('  2. Variables → New Variable → use "Reference" → pick PostgreSQL → DATABASE_URL.');
  console.error('     (Or paste the full postgresql://… URL from the Postgres service → Connect.)');
  console.error('  3. Remove any empty DATABASE_URL row (name with no value counts as empty).');
  console.error('  4. Redeploy.\n');
  process.exit(1);
}

execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
