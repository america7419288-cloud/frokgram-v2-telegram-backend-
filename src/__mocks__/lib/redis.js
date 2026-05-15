// Manual mock for src/lib/redis.ts
// Used automatically by Jest when moduleNameMapper or __mocks__ is configured.
const noop = () => Promise.resolve(null);

const redisMock = {
  get: noop,
  set: () => Promise.resolve("OK"),
  setex: () => Promise.resolve("OK"),
  del: () => Promise.resolve(1),
  incr: () => Promise.resolve(1),
  expire: () => Promise.resolve(1),
  ping: () => Promise.resolve("PONG"),
  zadd: () => Promise.resolve(1),
  zrange: () => Promise.resolve([]),
  zrangebyscore: () => Promise.resolve([]),
  zrevrange: () => Promise.resolve([]),
  zrevrangebyscore: () => Promise.resolve([]),
  zrangeWithScores: () => Promise.resolve([]),
  zscore: noop,
  zcard: () => Promise.resolve(0),
  zincrby: () => Promise.resolve("1"),
  pipeline: () => ({
    zadd: function () { return this; },
    exec: () => Promise.resolve([]),
  }),
  disconnect: () => {},
  quit: () => Promise.resolve("OK"),
  on: function () { return this; },
  status: "ready",
};

module.exports = { redis: redisMock };
