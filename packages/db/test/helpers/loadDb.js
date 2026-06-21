const { createFakePrismaClient } = require('./fakePrismaClient');

// Swaps @prisma/client for our fake just long enough for a fresh require
// of the db module to pick it up, then restores whatever was cached
// before — so this never leaks into other test files or the real app.
function loadDbWithFakePrisma() {
  const fakeClient = createFakePrismaClient();

  const prismaClientPath = require.resolve('@prisma/client');
  const originalCacheEntry = require.cache[prismaClientPath];

  require.cache[prismaClientPath] = {
    id: prismaClientPath,
    filename: prismaClientPath,
    loaded: true,
    exports: {
      PrismaClient: function PrismaClient() {
        return fakeClient; // `new PrismaClient()` returns this object — valid JS, constructors may return an object explicitly
      },
    },
  };

  const dbModulePath = require.resolve('../../src/index.js');
  delete require.cache[dbModulePath]; // force re-evaluation so it re-requires @prisma/client right now, while it's faked
  const db = require(dbModulePath);

  if (originalCacheEntry) require.cache[prismaClientPath] = originalCacheEntry;
  else delete require.cache[prismaClientPath];

  return { db, fakeClient };
}

module.exports = { loadDbWithFakePrisma };
