require('dotenv').config();
const express = require('express');
const { verifyUser } = require('@bugtracker/db');

const app = express();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  PORT = 3000,
} = process.env;

// Step 1: send them to Discord's own consent screen. We never see or
// store a password — Discord is the one proving who they are.
app.get('/auth/discord', (req, res) => {
  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  res.redirect(url.toString());
});

// Step 2: Discord sends them back here with a one-time code we trade
// for an access token, then use that to ask Discord who this actually is.
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code from Discord.');

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

    res.send('<h1>Verified</h1><p>You can close this tab and go back to Discord.</p>');
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong verifying your account. Please try again.');
  }
});

app.listen(PORT, () => console.log(`Web app listening on :${PORT}`));
