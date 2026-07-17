# @bolojs/tcp-relay

Reference WebSocket-to-TCP relay for bolojs.

This is a standalone Node.js script that lets the browser open outbound and inbound TCP connections through a WebSocket bridge. It is intentionally minimal: one outbound connection per WebSocket message, no build step, no TypeScript.

## Run

```bash
node apps/tcp-relay/index.js
PORT=9001 node apps/tcp-relay/index.js
```

## Environment variables

- `RELAY_PORT` — WebSocket listen port (default `9000`)
- `TARGET_HOST` — optional default target host (not used by the relay itself; set for your own client convenience)

## Wire protocol

All messages are JSON objects sent as WebSocket binary frames:

Browser → Relay: `connect`, `listen`, `unlisten`, `data`, `close`  
Relay → Browser: `connected`, `listening`, `connection`, `unlistened`, `data`, `close`

See `index.js` for the exact message shape.

## Security

This relay provides only basic per-IP rate limiting (10 connections per IP per minute). It is **not** production hardened. Before exposing it, add TLS, authentication, and proper DDoS protection.

## Links

- bolojs docs: https://bolojs.pages.dev/docs/
- Project home: https://github.com/bolojs/bolo
