const express = require('express');
const auth = require('../middleware/auth');
const { normalizeLanguageOverride } = require('../utils/language');
const router = express.Router();

router.use(auth);

// GET /api/agents
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agents = await prisma.agent.findMany({
      where: { userId: req.userId },
      include: { scriptSteps: { orderBy: { stepOrder: 'asc' } }, phoneNumbers: true, _count: { select: { conversations: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ success: true, data: agents });
  } catch (err) { next(err); }
});

// GET /api/agents/:id
router.get('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await prisma.agent.findFirst({
      where: { id: req.params.id, userId: req.userId },
      include: { scriptSteps: { orderBy: { stepOrder: 'asc' } }, phoneNumbers: true }
    });
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    res.json({ success: true, data: agent });
  } catch (err) { next(err); }
});

// POST /api/agents
router.post('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, systemPrompt, channels, voiceId, voiceName, llmModel, temperature,
            maxCallDuration, greetingMessage, goodbyeMessage, fallbackBehavior,
            role, salesAgentId, handoffMessage, languageOverride } = req.body;
    if (!name || !systemPrompt) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'Name and system prompt required' } });
    }
    // If salesAgentId is provided, validate ownership
    if (salesAgentId) {
      const sa = await prisma.agent.findFirst({ where: { id: salesAgentId, userId: req.userId } });
      if (!sa) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_SALES_AGENT', message: 'Sales agent not found or not owned' } });
      }
    }
    const agent = await prisma.agent.create({
      data: {
        userId: req.userId, name, description, systemPrompt,
        channels: channels ? JSON.stringify(channels) : undefined,
        voiceId, voiceName,
        llmModel: llmModel || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
        temperature: temperature || 0.7,
        maxCallDuration: maxCallDuration || 600,
        greetingMessage, goodbyeMessage,
        fallbackBehavior: fallbackBehavior || 'take_message',
        role: role || 'standalone',
        salesAgentId: salesAgentId || null,
        handoffMessage: handoffMessage || null,
        languageOverride: normalizeLanguageOverride(languageOverride)
      }
    });
    res.status(201).json({ success: true, data: agent });
  } catch (err) { next(err); }
});

// PUT /api/agents/:id
router.put('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    const data = { ...req.body };
    if (data.channels) data.channels = JSON.stringify(data.channels);
    delete data.id; delete data.userId; delete data.createdAt;
    // pricingVariables and pricingFormula are managed via /api/pricing — strip
    // them out here so users don't accidentally bypass validation.
    delete data.pricingVariables; delete data.pricingFormula; delete data.pricingCurrency;
    delete data.scriptSteps;
    delete data.phoneNumbers;
    delete data.intakeAgent;
    delete data.salesAgent;
    delete data._count;
    if (Object.prototype.hasOwnProperty.call(data, 'languageOverride')) {
      data.languageOverride = normalizeLanguageOverride(data.languageOverride);
    }
    // Validate salesAgentId ownership if changing
    if (data.salesAgentId && data.salesAgentId !== existing.salesAgentId) {
      const sa = await prisma.agent.findFirst({ where: { id: data.salesAgentId, userId: req.userId } });
      if (!sa) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_SALES_AGENT', message: 'Sales agent not found or not owned' } });
      }
      if (data.salesAgentId === existing.id) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_SALES_AGENT', message: 'An agent cannot be its own sales agent' } });
      }
    }
    const agent = await prisma.agent.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: agent });
  } catch (err) { next(err); }
});

// DELETE /api/agents/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.agent.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    await prisma.agent.delete({ where: { id: req.params.id } });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
