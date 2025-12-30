# byselfdb server

secure, stateless backend for mongodb connections.
no auth db. no tracking. just a proxy.

## features

- **stateless** · credentials stay in memory. never saved to disk.
- **secure sessions** · 256-bit logic. auto-expiry.
- **hardened** · ssrf protection. injection defense. rate limits.
- **isolated** · users don't share connections.

## stack

- node.js + express
- mongodb native driver
- zod validation

## how it works

1. **connect** · user sends uri → server validates → establishes connection.
2. **session** · server keeps connection map. gives user a random cookie.
3. **query** · user asks for data → server proxies it securely.
4. **bye** · user leaves → server kills connection immediately.

## setup

copy `.env.example` to `.env`:

```bash
PORT=3001
NODE_ENV=development
SESSION_SECRET=make_this_long_and_random
CORS_ORIGIN=http://localhost:5173
```

run it:

```bash
npm install
npm run dev
```

## deployment

deploy as a **single instance** (railway / render / fly).

> **note**: sessions live in ram. if the server sleeps or restarts, everyone gets logged out. feature, not a bug. k.i.s.s.

## security

- https required in prod.
- set `CORS_ORIGIN` correctly. don't use `*`.
- don't horizontally scale (multiple replicas) without redis.

read [security.md](SECURITY.md) for the deep dive.

## license

mit.
