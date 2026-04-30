const logger = require('../utils/logger');

/**
 * Logs every HTTP request after response completes (method, URL, status, duration).
 * Twilio webhook paths are highlighted with [Twilio].
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const pathOnly = req.originalUrl.split('?')[0];
  const twilio = pathOnly.includes('/webhooks/');

  res.on('finish', () => {
    const ms = Date.now() - start;
    const msg = `${twilio ? '[Twilio] ' : ''}${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) logger.error(msg);
    else if (res.statusCode >= 400) logger.warn(msg);
    else logger.info(msg);
  });

  next();
}

module.exports = requestLogger;
