#!/usr/bin/env node
/**
 * Verifies DATABASE_URL before running the app or migrations.
 * Usage: npm run db:ping
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

function hint(urlStr, err) {
  let host = '?';
  let port = '?';
  let user = '?';
  try {
    const u = new URL(urlStr.replace(/^postgresql:/i, 'http:'));
    host = u.hostname;
    port = u.port || '5432';
    user = decodeURIComponent(u.username || '');
  } catch {
    // ignore parse errors
  }

  const code = err && err.code;
  const msg = String(err && err.message ? err.message : err);

  console.error('\n[AgentAi] Cannot connect to the database.\n');
  console.error(`  Target: ${host}:${port} (user: ${user})`);
  console.error(`  ${msg}\n`);

  if (code === 'ECONNREFUSED') {
    console.error('  Nothing is accepting connections on that host/port.');
    console.error('  • If you use Docker: from the project folder run  docker compose up -d');
    console.error('  • Then ensure DATABASE_URL matches docker-compose (see .env.example).\n');
    return;
  }

  if (/P1000|password authentication failed|credentials.*not valid/i.test(msg)) {
    console.error('  PostgreSQL rejected this user/password.');
    console.error('  Common causes on Windows:');
    console.error('  • Port 5432 is your *installed* Postgres, not the AgentAi container.');
    console.error('    Start Docker Desktop, run  docker compose up -d , and use the URL from .env.example.');
    console.error('  • Or create the dev user/database on your local Postgres (superuser):');
    console.error('      psql -U postgres -f scripts/create-dev-db.sql');
    console.error('  • If you changed POSTGRES_PASSWORD in docker-compose after the first `up`,');
    console.error('    the old password stays in the volume. Fix:  docker compose down -v');
    console.error('    then  docker compose up -d  (this deletes container DB data).\n');
    return;
  }

  console.error('  Check DATABASE_URL in .env and that Postgres is running.\n');
}

const url = process.env.DATABASE_URL;
if (!url || !String(url).trim()) {
  console.error('[AgentAi] DATABASE_URL is missing. Copy .env.example to .env and set it.\n');
  process.exit(1);
}

const prisma = new PrismaClient();
prisma
  .$connect()
  .then(() => {
    console.log('[AgentAi] Database connection OK.');
    return prisma.$disconnect();
  })
  .then(() => process.exit(0))
  .catch((err) => {
    hint(url, err);
    prisma.$disconnect().finally(() => process.exit(1));
  });
