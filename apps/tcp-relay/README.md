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

All messages are binary WebSocket frames with the layout:

```
[1 byte type][8 bytes connectionId hex][payload...]
```

Frame types:

- `0x01` connect — Browser→Relay, payload is JSON `{host, port}`
- `0x02` connected — Relay→Browser, payload empty
- `0x03` data — Both, payload is raw bytes
- `0x04` close — Both, payload empty (half-close)
- `0x05` error — Relay→Browser, payload is JSON `{code, syscall, address, port, message}`
- `0x06` listen — Browser→Relay, payload is JSON `{port, host}`
- `0x07` listening — Relay→Browser, payload empty
- `0x08` accept — Relay→Browser, payload is JSON `{remoteAddress, remotePort}`
- `0x09` unlisten — Browser→Relay, payload empty
- `0x0a` unlistened — Relay→Browser, payload empty
- `0x0b` destroy — Browser→Relay, payload empty (full teardown)

See `index.js` for the exact encoding helpers.

## Security

This relay provides only basic per-IP rate limiting (10 connections per IP per minute). It is **not** production hardened. Before exposing it, add TLS, authentication, and proper DDoS protection.

## Links

- bolojs docs: https://bolojs.dev/docs/
- Project home: https://github.com/bolojs/bolo
