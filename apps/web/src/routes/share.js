const express = require('express');
const { redeemShareLink } = require('@bugtracker/db');

const router = express.Router();

router.get('/share/:shareLinkId', async (req, res) => {
  const { shareLinkId } = req.params;

  if (!req.session.discordId) {
    const returnTo = encodeURIComponent(`/share/${shareLinkId}`);
    return res.redirect(`/auth/discord?returnTo=${returnTo}`);
  }

  try {
    const access = await redeemShareLink({ shareLinkId, discordId: req.session.discordId });
    res.redirect(`/dashboard/${access.serverId}`);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

module.exports = router;
