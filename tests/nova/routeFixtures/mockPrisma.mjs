// Configurable Prisma mock. Tests set globalThis.__novaPrismaMock before calling
// code under test; the proxy re-reads it on every property access so different
// scenarios can swap handlers per-test without re-importing.
export const prisma = new Proxy({}, {
  get(_target, prop) {
    const mocks = globalThis.__novaPrismaMock;
    if (!mocks) return undefined;
    return mocks[prop];
  },
});
