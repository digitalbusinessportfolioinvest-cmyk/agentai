const express = require('express');
const auth = require('../middleware/auth');
const router = express.Router();

router.use(auth);

// GET /api/settings
router.get('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    res.json({
      success: true,
      data: {
        hasTwilio: !!(user.twilioSid && user.twilioToken),
        hasElevenlabs: !!user.elevenlabsKey,
        hasOpenrouter: !!user.openrouterKey,
        companyName: user.companyName,
        plan: user.plan
      }
    });
  } catch (err) { next(err); }
});

// PUT /api/settings
router.put('/', async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { twilioSid, twilioToken, elevenlabsKey, openrouterKey, companyName } = req.body;
    const data = {};
    if (twilioSid !== undefined) data.twilioSid = twilioSid;
    if (twilioToken !== undefined) data.twilioToken = twilioToken;
    if (elevenlabsKey !== undefined) data.elevenlabsKey = elevenlabsKey;
    if (openrouterKey !== undefined) data.openrouterKey = openrouterKey;
    if (companyName !== undefined) data.companyName = companyName;
    await prisma.user.update({ where: { id: req.userId }, data });
    res.json({ success: true, data: { updated: true } });
  } catch (err) { next(err); }
});

module.exports = router;
