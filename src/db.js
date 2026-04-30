/** Load env before Prisma — this module may be required before server.js runs. */
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const logger = require('./utils/logger');

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl || !String(rawUrl).trim()) {
  throw new Error(
    'DATABASE_URL is missing or empty. Set a PostgreSQL connection string in .env (see .env.example).'
  );
}

const databaseUrl = String(rawUrl).trim();
if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  throw new Error(
    'DATABASE_URL must be a PostgreSQL URL (postgresql:// or postgres://). SQLite and other providers are not supported.'
  );
}

/** Query logs on in development unless PRISMA_QUERY_LOG=false */
const enableQueryLog =
  process.env.NODE_ENV !== 'production' && process.env.PRISMA_QUERY_LOG !== 'false';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrl
    }
  },
  log: enableQueryLog
    ? [
        { level: 'query', emit: 'event' },
        { level: 'warn', emit: 'stdout' },
        { level: 'error', emit: 'stdout' }
      ]
    : [{ level: 'warn', emit: 'stdout' }, { level: 'error', emit: 'stdout' }]
});

if (enableQueryLog) {
  prisma.$on('query', (e) => {
    logger.debug(`[Prisma] ${e.duration}ms ${e.query}`);
  });
}

try {
  const u = new URL(databaseUrl.replace(/^postgres(ql)?:/i, 'http:'));
  logger.info(`[DB] Prisma → PostgreSQL at ${u.hostname}:${u.port || '5432'} (from DATABASE_URL)`);
} catch {
  logger.info('[DB] Prisma client initialized (DATABASE_URL set)');
}

module.exports = prisma;
