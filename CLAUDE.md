# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The official Threat.Zone MCP (Model Context Protocol) server. Currently provides VNC computer-use capabilities (screenshots, keyboard/mouse control, clipboard, file transfer) over stdio transport. Structured as a multi-domain server where each feature domain (VNC, future APIs, etc.) is self-contained.

## Commands

- `yarn build` — compile TypeScript to `dist/`
- `yarn start` — run the compiled server (`node dist/index.js`)
- `yarn start:dev` — run from source via ts-node (no watch mode, restart manually)
- `yarn check` — lint/format with Biome
- `yarn check:write` — lint/format and auto-fix
- `yarn test` — run Jest (currently no tests)

**Note:** `yarn check` (without `run`) invokes yarn's built-in integrity check, not Biome. Always use `yarn run check` or `yarn run check:write`.

## Architecture

`src/index.ts` is a thin orchestrator: creates the `McpServer`, calls domain registration functions, and starts the stdio transport.

Each feature domain lives in its own directory under `src/` and exports a `registerXxxTools(server)` function. To add a new domain, create the directory and add one call in `index.ts`.

### VNC domain (`src/vnc/`)

- **`register.ts`** — `registerVncTools(server)` registers all 15 VNC tools with their Zod schemas. Instantiates `SessionManager` and `TokenResolver`.
- **`tools/`** — One handler file per MCP tool (connect, disconnect, screenshot, send-key, type-text, mouse-click, mouse-move, mouse-drag, scroll, get-screen-size, wait-for-screen-change, clipboard-read, clipboard-write, file-upload, file-download).
- **`protocol/`** — VNC protocol layer:
  - Three connection backends selected by probing security types: `rfb-backend.ts` (None/VNC-Auth), `ra2ne-client.ts` (RSA-AES), `vencrypt-client.ts` (VeNCrypt/TLS). All implement `RfbBackend`.
  - `vnc-client.ts` orchestrates backend selection, manages the `Framebuffer` for screenshots.
  - `session-manager.ts` holds multiple named sessions, tracks a default.
  - `ws-transport.ts` provides WebSocket transport for websockify proxies.
- **`redis/`** — `TokenResolver` resolves session tokens to host:port via Redis keys (`vnc-<token>`). Only active when `REDIS_URL` is set.
- **`errors.ts`** — `VncError` (extends `McpToolError` from `src/shared/errors.ts`) plus domain-specific error subclasses.

## Landmines

- **`rfb2` has no published types.** `src/vnc/protocol/rfb2.d.ts` is hand-written from runtime inspection. If upgrading `rfb2`, verify augmented properties (`redShift`, `greenShift`, `blueShift`, `bpp`, `depth`) at runtime.
- **`skipLibCheck: true` is load-bearing** — removing it breaks the build due to `rfb2` lacking proper type exports.
- **Stdout is the MCP transport.** Any `console.log()` corrupts the protocol stream. Use `console.error()` for debug output only.
- **Framebuffer assumes little-endian** pixel layout. Big-endian VNC servers will produce garbled screenshots.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `null` (disables token connect) | Redis connection string for token resolution |
| `VNC_CONNECT_TIMEOUT` | `10000` ms | Connection timeout |
| `VNC_SCREENSHOT_TIMEOUT` | `5000` ms | Framebuffer update timeout |
| `VNC_DEFAULT_PORT` | `5901` | Fallback port for token-resolved targets |
