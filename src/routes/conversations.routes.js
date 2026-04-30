const express = require('express');
const auth = require('../middleware/auth');
const router = express.Router();

router.use(auth);

// GET /api/conversations
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { agentId, channel, status, direction, limit = 50, offset = 0 } = req.query;
    const where = { userId: req.userId };
    if (agentId) where.agentId = agentId;
    if (channel) where.channel = channel;
    if (status) where.status = status;
    if (direction) where.direction = direction;
    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where, include: {
          agent: { select: { id: true, name: true } },
          _count: { select: { messages: true, collectedData: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit), skip: parseInt(offset)
      }),
      prisma.conversation.count({ where })
    ]);
    res.json({ success: true, data: conversations, meta: { total, limit: parseInt(limit), offset: parseInt(offset) } });
  } catch (err) { next(err); }
});

// GET /api/conversations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: {
        agent: { select: { id: true, name: true } },
        phoneNumber: { select: { id: true, twilioNumber: true, label: true } },
        messages: { orderBy: { createdAt: 'asc' } },
        collectedData: { include: { scriptStep: { select: { label: true, promptText: true } } } }
      }
    });
    if (!conversation) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
    res.json({ success: true, data: conversation });
  } catch (err) { next(err); }
});

module.exports = router;
