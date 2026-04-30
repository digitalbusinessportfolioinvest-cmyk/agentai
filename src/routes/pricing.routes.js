const express = require('express');
const auth = require('../middleware/auth');
const pricing = require('../services/pricing.service');
const logger = require('../utils/logger');
const router = express.Router();

router.use(auth);

// Helper: find an agent owned by the current user
async function ownedAgent(prisma, agentId, userId) {
  return prisma.agent.findFirst({ where: { id: agentId, userId } });
}

// GET /api/pricing/:agentId
// Read the pricing config (variables + formula) for an agent
router.get('/:agentId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownedAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    res.json({
      success: true,
      data: {
        variables: agent.pricingVariables ? JSON.parse(agent.pricingVariables) : [],
        formula: agent.pricingFormula || '',
        currency: agent.pricingCurrency || 'EUR',
        configured: !!(agent.pricingVariables && agent.pricingFormula),
        maxVariables: pricing.MAX_VARIABLES
      }
    });
  } catch (err) { next(err); }
});

// PUT /api/pricing/:agentId
// Save pricing configuration. Validates everything before persisting so the
// agent never ends up with a config that would crash at calculation time.
router.put('/:agentId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownedAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const { variables, formula, currency } = req.body;
    if (!Array.isArray(variables) || typeof formula !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'INVALID', message: 'Body must include variables (array) and formula (string)' } });
    }

    // Validate before saving — throws on any problem
    try {
      pricing.validateConfig({ variables, formula });
    } catch (e) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_PRICING', message: e.message } });
    }

    const updated = await prisma.agent.update({
      where: { id: req.params.agentId },
      data: {
        pricingVariables: JSON.stringify(variables),
        pricingFormula: formula,
        pricingCurrency: currency || 'EUR'
      }
    });

    res.json({
      success: true,
      data: {
        variables: JSON.parse(updated.pricingVariables),
        formula: updated.pricingFormula,
        currency: updated.pricingCurrency
      }
    });
  } catch (err) { next(err); }
});

// POST /api/pricing/:agentId/test
// Run the agent's formula against arbitrary inputs without touching any
// conversation. Lets the user verify the configuration from the dashboard.
router.post('/:agentId/test', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownedAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const { inputs } = req.body;
    if (!inputs || typeof inputs !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'INVALID', message: 'Body must include "inputs" object' } });
    }

    try {
      const result = pricing.calculate(agent, inputs);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, error: { code: 'CALC_FAILED', message: e.message } });
    }
  } catch (err) { next(err); }
});

// POST /api/pricing/:agentId/calculate-for-conversation
// Internal endpoint used by the conversation engine when the intake script
// completes. Reads collected data, runs the formula, stores the total on the
// conversation, returns it. Used to drive the handoff to the sales agent.
router.post('/:agentId/calculate-for-conversation', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownedAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const { conversationId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ success: false, error: { code: 'INVALID', message: 'conversationId required' } });
    }

    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, userId: req.userId },
      include: { collectedData: true }
    });
    if (!conv) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Conversation not found' } });

    // Build inputs from collected data using each entry's label
    const inputs = {};
    for (const cd of conv.collectedData) {
      inputs[cd.label] = cd.value;
    }

    let result;
    try {
      result = pricing.calculate(agent, inputs);
    } catch (e) {
      logger.error(`Pricing calc failed for conv ${conversationId}: ${e.message}`);
      return res.status(400).json({ success: false, error: { code: 'CALC_FAILED', message: e.message } });
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { calculatedTotal: result.amount }
    });

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

module.exports = router;
