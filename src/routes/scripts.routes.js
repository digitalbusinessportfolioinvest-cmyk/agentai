const express = require('express');
const auth = require('../middleware/auth');
const router = express.Router();

router.use(auth);

// Helper: verify the user owns the agent
async function ownsAgent(prisma, agentId, userId) {
  const agent = await prisma.agent.findFirst({ where: { id: agentId, userId } });
  return agent || null;
}

// Helper: verify the user owns the step (via its agent)
async function ownsStep(prisma, stepId, userId) {
  const step = await prisma.scriptStep.findUnique({
    where: { id: stepId },
    include: { agent: { select: { userId: true } } }
  });
  if (!step || step.agent.userId !== userId) return null;
  return step;
}

// GET /api/scripts/:agentId
router.get('/:agentId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownsAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    const steps = await prisma.scriptStep.findMany({
      where: { agentId: req.params.agentId },
      orderBy: { stepOrder: 'asc' }
    });
    res.json({ success: true, data: steps });
  } catch (err) { next(err); }
});

// PUT /api/scripts/:agentId/reorder — reorder all steps
// IMPORTANT: this MUST be registered before PUT /:agentId/:stepId, otherwise
// Express matches the more generic route first and "reorder" is treated as a stepId.
router.put('/:agentId/reorder', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownsAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });

    const { stepIds } = req.body; // ordered array of step IDs
    if (!Array.isArray(stepIds)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID', message: 'stepIds must be an array' } });
    }

    // Verify every stepId belongs to this agent (prevents cross-tenant manipulation)
    const existingSteps = await prisma.scriptStep.findMany({
      where: { agentId: req.params.agentId },
      select: { id: true }
    });
    const validIds = new Set(existingSteps.map(s => s.id));
    for (const id of stepIds) {
      if (!validIds.has(id)) {
        return res.status(400).json({ success: false, error: { code: 'INVALID_STEP', message: `Step ${id} does not belong to this agent` } });
      }
    }

    // Apply new ordering atomically
    await prisma.$transaction(
      stepIds.map((id, i) => prisma.scriptStep.update({
        where: { id },
        data: { stepOrder: i + 1 }
      }))
    );

    const steps = await prisma.scriptStep.findMany({
      where: { agentId: req.params.agentId }, orderBy: { stepOrder: 'asc' }
    });
    res.json({ success: true, data: steps });
  } catch (err) { next(err); }
});

// POST /api/scripts/:agentId — add step
router.post('/:agentId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const agent = await ownsAgent(prisma, req.params.agentId, req.userId);
    if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    const { label, promptText, dataType, choices, isRequired, conditionStepId, conditionValue } = req.body;
    if (!label || !promptText || !dataType) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'label, promptText, and dataType required' } });
    }
    const maxOrder = await prisma.scriptStep.findFirst({
      where: { agentId: req.params.agentId }, orderBy: { stepOrder: 'desc' }
    });
    const step = await prisma.scriptStep.create({
      data: {
        agentId: req.params.agentId, label, promptText, dataType,
        choices: choices ? JSON.stringify(choices) : null,
        isRequired: isRequired !== false,
        stepOrder: (maxOrder?.stepOrder || 0) + 1,
        conditionStepId, conditionValue
      }
    });
    res.status(201).json({ success: true, data: step });
  } catch (err) { next(err); }
});

// PUT /api/scripts/:agentId/:stepId
router.put('/:agentId/:stepId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const step = await ownsStep(prisma, req.params.stepId, req.userId);
    if (!step || step.agentId !== req.params.agentId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Step not found' } });
    }
    const data = { ...req.body };
    if (data.choices) data.choices = JSON.stringify(data.choices);
    delete data.id; delete data.agentId; delete data.createdAt;
    const updated = await prisma.scriptStep.update({ where: { id: req.params.stepId }, data });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// DELETE /api/scripts/:agentId/:stepId
router.delete('/:agentId/:stepId', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const step = await ownsStep(prisma, req.params.stepId, req.userId);
    if (!step || step.agentId !== req.params.agentId) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Step not found' } });
    }
    await prisma.scriptStep.delete({ where: { id: req.params.stepId } });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
