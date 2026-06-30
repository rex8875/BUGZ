// Run this any time the project folder gets moved, renamed, or copied
// (e.g. bugtracker-final -> bugtracker-final2) — it writes the correct
// absolute DATABASE_URL into all three .env files automatically.
//
// Why this exists: relative SQLite paths are NOT reliably safe in an
// npm-workspaces monorepo like this one — @prisma/client can get
// hoisted to a shared root node_modules, and the generated client then
// resolves relative paths against THAT location, not the schema file
// (see https://github.com/prisma/prisma/issues/9649). Absolute paths
// sidestep that entirely, but they break the moment the folder is
// renamed or moved — which is exactly what bit us by hand. This script
// just recomputes them.
//
// Usage: node fix-database-url.js

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'packages', 'db', 'prisma', 'dev.db');
// Prisma's file: URLs always use forward slashes, even on Windows.
const url = `file:${dbPath.replace(/\\/g, '/')}`;

const targets = [
  path.join(__dirname, 'apps', 'bot', '.env'),
  path.join(__dirname, 'apps', 'web', '.env'),
];

for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.log(`SKIPPED (not found): ${file}`);
    continue;
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith('DATABASE_URL=')) {
      found = true;
      return `DATABASE_URL="${url}"`;
    }
    return line;
  });
  if (!found) updated.unshift(`DATABASE_URL="${url}"`);

  fs.writeFileSync(file, updated.join('\n'));
  console.log(`Updated: ${file}`);
  console.log(`  -> DATABASE_URL="${url}"`);
}

console.log('\nDone. packages/db/.env is left alone on purpose — it already uses a path Prisma resolves correctly on its own.');
