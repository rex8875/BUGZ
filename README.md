# Bug Tracker

A Discord bot + web dashboard for tester/dev bug tracking. Multi-server (each
Discord server's data is fully isolated, like a ticket bot), with Discord
OAuth verification, custom per-server roles and permissions, a leaderboard,
and shareable dashboard links for people outside the server.

## Structure

- `apps/bot` — the Discord bot (discord.js)
- `apps/web` — the dashboard (Express + a small vanilla-JS frontend, no framework)
- `packages/db` — shared Prisma schema + the data-access layer everything else calls through

Nothing in `apps/bot` or `apps/web` talks to the database directly — they
only go through `packages/db/src/index.js`, and every mutating function in
there re-checks permissions itself rather than trusting the caller. See the
test suite for what that guarantees.

## Setup

1. **Discord application** (discord.com/developers/applications)
   - New Application → note the **Application ID** (`DISCORD_CLIENT_ID`)
   - Bot tab → Add Bot → Reset Token → copy it (`DISCORD_BOT_TOKEN`)
   - OAuth2 tab → copy **Client Secret** (`DISCORD_CLIENT_SECRET`) → under
     Redirects, add `http://localhost:3000/auth/discord/callback`
   - OAuth2 → URL Generator → scopes `bot` + `applications.commands` →
     permissions: Send Messages, Create Public Threads, Embed Links → open
     the generated URL, invite it to a test server

2. **Environment files** — copy `.env.example` into `apps/bot/.env`,
   `apps/web/.env`, and `packages/db/.env` (each process reads its own).

3. **Install and set up the database**
   ```
   npm install
   npm run db:generate
   npm run db:push
   ```

4. **Register slash commands**
   ```
   npm run bot:deploy
   ```

5. **Run it** (two terminals)
   ```
   npm run bot:dev
   npm run web:dev
   ```

6. In your test server: `/verify` → click through Discord login (you'll
   auto-become Owner since you invited the bot). `/create-prompt` posts the
   report-bug button. `http://localhost:3000/dashboard` is the dashboard.

## Testing

```
npm test
```

Runs the full suite with Node's built-in test runner — no extra dependency,
no real database required. The data-layer tests run the actual production
code in `packages/db/src/index.js` against an in-memory fake Prisma client
(`packages/db/test/helpers/fakePrismaClient.js`), which is itself covered by
a self-test file before anything else trusts it.

Covers: ownership transfer and auto-claim, every permission boundary (member
vs. guest, including direct-call attempts that bypass the route layer),
rank-safety on promote/kick/ban (can't touch or grant your own rank or
above), the leaderboard point lifecycle (award, duplicate-deduction,
refund — bucketed by the report's original week, not whenever a correction
happens), the 15-day archive cleanup job, and multi-server isolation (the
same person can hold different roles in different servers, and nothing
leaks between them).

Bot-side pure logic (modal field counts staying under Discord's 5-component
limit, the draft store's TTL) is tested separately under `apps/bot/test`,
with no Prisma involved at all.

What this suite does *not* cover, because it can't from logic tests alone:
real Discord API behavior, OAuth token exchange, or anything specific to
an actual SQLite file. Those only get exercised by actually running it.
