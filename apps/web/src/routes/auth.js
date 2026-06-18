const express = require('express');
const { verifyUser } = require('@bugtracker/db');

const router = express.Router();

const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI } = process.env;

function encodeState(returnTo) {
  return Buffer.from(JSON.stringify({ returnTo: returnTo || '/dashboard' })).toString('base64url');
}

function decodeState(state) {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return { returnTo: '/dashboard' };
  }
}

// Step 1: send them to Discord's own consent screen. ?returnTo= lets
// callers (like the share-link route) say where to land afterward.
router.get('/auth/discord', (req, res) => {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', encodeState(req.query.returnTo));
  res.redirect(url.toString());
});

// Step 2: Discord sends them back here with a one-time code.
router.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing code from Discord.');
  const { returnTo } = decodeState(state);

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Discord did not return an access token.');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const discordUser = await userRes.json();

    await verifyUser({ discordId: discordUser.id, discordUsername: discordUser.username });

    req.session.discordId = discordUser.id;
    req.session.discordUsername = discordUser.username;
    res.redirect(returnTo);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong verifying your account. Please try again.');
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
