// Env must load before any module that touches process.env (db.js also calls dotenv.config()).
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const prisma = require('./db');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth.routes');
const agentRoutes = require('./routes/agents.routes');
const scriptRoutes = require('./routes/scripts.routes');
const numberRoutes = require('./routes/numbers.routes');
const conversationRoutes = require('./routes/conversations.routes');
const webhooksVoiceRoutes = require('./routes/webhooks.voice.routes');
const webhooksWhatsappRoutes = require('./routes/webhooks.whatsapp.routes');
const settingsRoutes = require('./routes/settings.routes');
const pricingRoutes = require('./routes/pricing.routes');
const outputV1Routes = require('./routes/v1/output.v1');

const app = express();
const PORT = process.env.PORT || 3000;

// WebSocket server for Twilio Media Streams (voice)
const http = require('http');
const WebSocket = require('ws');
const { handleMediaStream } = require('./services/voice.stream.service');

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/api/webhooks/voice/media-stream' });

wss.on('connection', (ws, req) => {
  logger.info('Media Stream WebSocket connected');

  // Twilio sends params in the 'start' event, but we also get them from the URL
  let initialized = false;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      // Initialize on the 'start' event which contains the custom parameters
      if (msg.event === 'start' && !initialized) {
        const params = msg.start.customParameters || {};
        const conversationId = params.conversationId;
        const agentId = params.agentId;
        const language = params.language || 'es';

        if (conversationId && agentId) {
          logger.info(`Media Stream initialized: conv=${conversationId}, agent=${agentId}, lang=${language}`);
          handleMediaStream(ws, conversationId, agentId, language);
          initialized = true;
        } else {
          logger.error('Media Stream missing conversationId or agentId');
          ws.close();
        }
      }
    } catch (err) {
      // Not JSON or parse error — ignore, the handleMediaStream will handle its own messages
    }
  });
});

const path = require('path');

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
const corsOrigin =
  process.env.NODE_ENV === 'production'
    ? (process.env.APP_URL || '*')
    : '*';
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('./middleware/request-log'));

// Serve frontend dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// Make prisma available in routes
app.locals.prisma = prisma;

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/scripts', scriptRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/webhooks/voice', webhooksVoiceRoutes);
app.use('/api/webhooks/whatsapp', webhooksWhatsappRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/v1', outputV1Routes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

// SPA catch-all — serve index.html for any non-API route
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    return;
  }
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
});

// Error handler (unhandled exceptions & next(err))
app.use((err, req, res, next) => {
  logger.error(`[API Error] ${req.method} ${req.originalUrl} — ${err.message}`);
  logger.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    error: { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Something went wrong' }
  });
});

// Start server (use http server for WebSocket support)
// Bind 0.0.0.0 so Railway / Docker / cloud healthchecks can reach the port.
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`AgentAi server running on port ${PORT}`);
  logger.info(`Dashboard: http://localhost:${PORT}`);
  logger.info(`API: http://localhost:${PORT}/api/health`);
  if (process.env.NGROK_URL) {
    logger.info(`Ngrok: ${process.env.NGROK_URL}`);
    logger.info(`Twilio Voice Webhook: ${process.env.NGROK_URL}/api/webhooks/voice/incoming`);
    logger.info(`Twilio WhatsApp Webhook: ${process.env.NGROK_URL}/api/webhooks/whatsapp/incoming`);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
