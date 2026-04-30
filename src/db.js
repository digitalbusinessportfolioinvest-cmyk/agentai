const { PrismaClient } = require('@prisma/client');
const logger = require('./utils/logger');

/** Query logs on in development unless PRISMA_QUERY_LOG=false */
const enableQueryLog =
  process.env.NODE_ENV !== 'production' && process.env.PRISMA_QUERY_LOG !== 'false';

const prisma = new PrismaClient({
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

module.exports = prisma;
