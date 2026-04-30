const express = require('express');
const auth = require('../middleware/auth');
const router = express.Router();

router.use(auth);

// Helper: verify ownership of a phone number
async function ownsNumber(prisma, numberId, userId) {
  return prisma.phoneNumber.findFirst({ where: { id: numberId, userId } });
}

// GET /api/numbers
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const numbers = await prisma.phoneNumber.findMany({
      where: { userId: req.userId },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: numbers });
  } catch (err) { next(err); }
});

// POST /api/numbers
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { twilioNumber, twilioSid, countryCode, language, channels, label, agentId } = req.body;
    if (!twilioNumber || !language) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'twilioNumber and language required' } });
    }
    // If an agentId is provided, ensure the user owns that agent
    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: req.userId } });
      if (!agent) return res.status(400).json({ success: false, error: { code: 'INVALID_AGENT', message: 'Agent not found or not owned by user' } });
    }
    const number = await prisma.phoneNumber.create({
      data: {
        userId: req.userId, twilioNumber, twilioSid, countryCode,
        language, channels: channels ? JSON.stringify(channels) : undefined,
        label, agentId
      }
    });
    res.status(201).json({ success: true, data: number });
  } catch (err) { next(err); }
});

// PUT /api/numbers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await ownsNumber(prisma, req.params.id, req.userId);
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Number not found' } });

    const data = { ...req.body };
    if (data.channels) data.channels = JSON.stringify(data.channels);
    delete data.id; delete data.userId; delete data.createdAt;

    // If reassigning to a different agent, validate ownership of the new agent
    if (data.agentId && data.agentId !== existing.agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: data.agentId, userId: req.userId } });
      if (!agent) return res.status(400).json({ success: false, error: { code: 'INVALID_AGENT', message: 'Agent not found or not owned by user' } });
    }

    const number = await prisma.phoneNumber.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: number });
  } catch (err) { next(err); }
});

// DELETE /api/numbers/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await ownsNumber(prisma, req.params.id, req.userId);
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Number not found' } });
    await prisma.phoneNumber.delete({ where: { id: req.params.id } });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
