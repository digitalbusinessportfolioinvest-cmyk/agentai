const express = require('express');
const auth = require('../../middleware/auth');
const { formatOutput, sendWebhook } = require('../../services/output.service');
const router = express.Router();

router.use(auth);

// GET /api/v1/conversations/:id/output
// Clean formatted output for external consumption
router.get('/conversations/:id/output', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { collectedData: true }
    });
    if (!conversation) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    }
    res.json({ success: true, data: formatOutput(conversation, conversation.collectedData) });
  } catch (err) { next(err); }
});

// GET /api/v1/conversations/completed
// List all completed conversations with their output data
router.get('/conversations/completed', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { agentId, from, to, limit = 50, offset = 0 } = req.query;
    const where = { userId: req.userId, status: 'completed' };
    if (agentId) where.agentId = agentId;
    if (from || to) {
      where.endedAt = {};
      if (from) where.endedAt.gte = new Date(from);
      if (to) where.endedAt.lte = new Date(to);
    }

    const conversations = await prisma.conversation.findMany({
      where,
      include: { collectedData: true, agent: { select: { id: true, name: true } } },
      orderBy: { endedAt: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
    });

    const total = await prisma.conversation.count({ where });

    res.json({
      success: true,
      data: conversations.map(c => formatOutput(c, c.collectedData)),
      meta: { total, limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (err) { next(err); }
});

// POST /api/v1/test-webhook
// Test webhook delivery — sends a sample payload to the given URL
router.post('/test-webhook', async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: { code: 'MISSING_URL', message: 'URL required' } });

    const testPayload = {
      conversation_id: 'test-' + Date.now(),
      agent_id: 'test-agent',
      agent_name: 'Test Agent',
      channel: 'whatsapp',
      direction: 'inbound',
      remote_number: '+34600000000',
      language: 'es',
      status: 'completed',
      outcome: 'data_collected',
      collected_data: { name: 'Test User', event_type: 'wedding', date: '2025-06-15', location: 'Madrid' },
      summary: 'Test webhook delivery from AgentAi',
      timestamp: new Date().toISOString()
    };

    const result = await sendWebhook(url, testPayload);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'WEBHOOK_FAILED', message: err.message } });
  }
});

module.exports = router;
