# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The official Threat.Zone MCP (Model Context Protocol) server. Provides VNC and WebRTC computer-use capabilities (screenshots, keyboard/mouse control, clipboard on VNC, file transfer on VNC, Android device buttons on RTC). Defaults to **Streamable HTTP transport** for on-prem hosting; `MCP_TRANSPORT=stdio` flips it back to stdio for local CLI debugging. Structured as a multi-domain server where each feature domain (VNC, RTC, future APIs) is self-contained but shares a `RemoteSession` interface that tool handlers consume.

## Commands

- `yarn build` — compile TypeScript to `dist/`
- `yarn start` — run the compiled server (`node dist/index.js`)
- `yarn start:dev` — run from source via ts-node (no watch mode, restart manually)
- `yarn check` — lint/format with Biome
- `yarn check:write` — lint/format and auto-fix
- `yarn test` — compile with `tsconfig.test.json` into `dist-test/` and run the `node:test` files in `test/`

**Note:** `yarn check` (without `run`) invokes yarn's built-in integrity check, not Biome. Always use `yarn run check` or `yarn run check:write`.

## Architecture

`src/index.ts` is a thin orchestrator: loads `.env` via `dotenv/config`, then branches on `MCP_TRANSPORT`. In HTTP mode it stands up an Express app with one `/mcp` route plus `/healthz`, instantiates a fresh `McpServer` + `StreamableHTTPServerTransport` per MCP session (keyed by the `mcp-session-id` header), and binds to `MCP_HTTP_HOST:MCP_HTTP_PORT` (defaults `127.0.0.1:7860`). In stdio mode it falls back to the original single-server `StdioServerTransport` boot. The same `registerVncTools(server)` runs in both paths.

**Transport mode and the server disk.** `index.ts` parses `MCP_TRANSPORT` once (`parseTransportMode` in `src/shared/tool-context.ts`) and passes a `ToolContext` to `registerApiTools(server, ctx)`. Tools read the mode from that context, never from `process.env`. In HTTP mode no tool reads or writes a path on the server disk: the `tz_download_*` schemas have no `save_to`, and `tz_submit_sandbox` / `tz_submit_static` / `tz_submit_cdr` have no `file_path` (only `file_base64` + `filename`). A download over 25 MB returns the Public API URL and a `curl` command with a `<YOUR_API_TOKEN>` placeholder, and the server does not read the body. stdio mode keeps `save_to` and `file_path`. VNC `file_upload` / `file_download` take base64 content and a remote VM path only, so they are the same in both modes. Keep this rule for every new tool.

Each feature domain lives in its own directory under `src/` and exports a `registerXxxTools(server)` function. To add a new domain, create the directory and add one call inside `startStdio` and `startHttp` in `index.ts` (the per-session McpServer setup).

**Session model.** Each HTTP MCP client gets its own transport + `McpServer`, but the module-level `SessionManager` and `TokenResolver` in `src/vnc/register.ts:23-24` are shared across all of them. Multiple clients can hold concurrent VNC/RTC sessions because they pass distinct `session_id` args to the `connect` tool — but a malicious or buggy client *could* reach another client's session by guessing/observing its `session_id`. This is the single-tenant on-prem trade-off; tighten only if you need multi-tenant isolation.

### Shared (`src/shared/`)

- **`remote-session.ts`** — `RemoteSession` interface implemented by both `VncClient` and `RtcClient`. Tool handlers consume sessions via this interface so they don't need to branch on transport. Methods that only apply to one side throw `UnsupportedOnTransportError` on the other (clipboard/file on RTC, `device_button` on VNC).
- **`errors.ts`** — `McpToolError` base class.

### VNC domain (`src/vnc/`)

- **`register.ts`** — `registerVncTools(server)` registers all 16 MCP tools with their Zod schemas. Instantiates `SessionManager` and `TokenResolver`. Despite the name and directory, this is the central dispatch for *all* session-routed tools (including RTC-only `device_button`); transport routing happens inside each handler via the shared `RemoteSession`.
- **`tools/`** — One handler file per MCP tool (connect, disconnect, screenshot, send-key, type-text, mouse-click, mouse-move, mouse-drag, scroll, get-screen-size, wait-for-screen-change, clipboard-read, clipboard-write, file-upload, file-download, device-button).
- **`protocol/`** — VNC protocol layer:
  - Three connection backends selected by probing security types: `rfb-backend.ts` (None/VNC-Auth), `ra2ne-client.ts` (RSA-AES), `vencrypt-client.ts` (VeNCrypt/TLS). All implement `RfbBackend`.
  - `vnc-client.ts` orchestrates backend selection, manages the `Framebuffer` for screenshots.
  - `session-manager.ts` holds multiple named sessions, tracks a default.
  - `ws-transport.ts` provides WebSocket transport for websockify proxies.
- **`errors.ts`** — `VncError` (extends `McpToolError` from `src/shared/errors.ts`) plus domain-specific error subclasses.
- **`tools/connect.ts`** — central dispatch. Accepted inputs: `submission_uuid` calls the Public API `GET /submissions/{uuid}/dynamic/session` (via `src/api/client.ts`, with `api_token` or `THREATZONE_API_TOKEN`) and dials the returned VNC link; `url` takes a raw `ws://`/`wss://` URL and keeps its scheme; `ws_url` (+ optional `ws_cookie`) takes a pre-built websockify URL. Bare UUIDs and submission page URLs in `url` are rejected. Output strips the URL query so the live-view token is never printed. `connect` does not open RTC sessions now: the session route returns only VNC links.

### RTC domain (`src/rtc/`)

WebRTC client for driving Android device gateways through the novnc `/webrtc-signal` proxy. Uses **`werift`** (pure-JS WebRTC) so the offer can advertise H.264 — the only codec the Android gateway answers. Earlier attempts with `@roamhq/wrtc` failed silently because it ships VP8/VP9/AV1 only, no H.264 → no codec overlap → no SDP answer.

- **`protocol/rtc-client.ts`** — `RtcClient implements RemoteSession`. On `connect()`: opens signaling, creates `RTCPeerConnection({ codecs: { video: [H264 baseline] } })`, declares a `control` data channel + recvonly video transceiver, exchanges offer/answer/ICE, waits for data channel + first decoded keyframe (so `screenSize` is populated before any input call). Whole sequence is bounded by an overall `RTC_CONNECT_TIMEOUT` budget; signaling close/error/PC failure rejects every in-flight handshake step via a shared `bail` rejector.
- **`protocol/signaling.ts`** — WebSocket signaling client for `/webrtc-signal`. Three JSON message types: outbound offer/ice, inbound answer/ice. Uses `rejectUnauthorized: false` (mirrors `vnc/protocol/ws-transport.ts`).
- **`protocol/control-channel.ts`** — JSON encoder for the `control` data channel: `touch`/`key`/`scroll`/device-button messages. Coordinates are normalized [0..1].
- **`protocol/keysym-to-code.ts`** — reverse map from X11 keysyms → DOM `KeyboardEvent.code`. Auto-shifts uppercase letters and shifted ASCII punctuation by wrapping with `ShiftLeft` press/release, so `type_text("Hello!")` works without explicit modifiers.
- **`protocol/h264-decoder.ts`** — H.264 RTP depacketizer (wraps `werift.H264RtpPayload`), Annex-B NAL splitter, and ffmpeg child-process wrappers (`decodeH264ToImage`, `probeH264Dimensions`).
- **`protocol/video-sink.ts`** — collects depacketized NAL units into a rolling GOP anchored on the latest IDR (with the most recent SPS/PPS prepended on every keyframe). `frameToImage()` pipes the GOP into `ffmpeg -f h264 -frames:v 1 -update 1 -f image2 -vcodec png pipe:1`.
- **`errors.ts`** — `RtcError`, `RtcConnectionError`, `RtcSignalingError`, `UnsupportedOnTransportError`.

### API domain (`src/api/`)

- **`src/api/register.ts`** — `registerApiTools(server, ctx)` wires all read-only tool groups (account, config, submission browse/analysis/threat/dynamic/scan/network/url, downloads) plus the submit tools (POST endpoints; consume plan quota). `ctx` is the `ToolContext` with the transport mode.
- **`src/api/client.ts`** — `apiRequest(opts)` typed fetch wrapper. Overloaded: `binary: true` returns `BinaryResponse` (`{ buffer, contentType, contentDisposition }`), otherwise returns parsed JSON. With `binary: true` and `maxBytes`, a body over the limit is not kept in memory (declared `Content-Length` over the limit: no body read; streamed body past the limit: stream cancelled), and the result is an `OversizeBinaryResponse` (`{ oversize, url, size, ... }`). Status→error class mapping for 400/401/403/404/409/422/429/5xx. `body instanceof FormData` passes through verbatim (no JSON-stringify, no manual `Content-Type`). Token resolved via `getApiToken(opts.apiToken)` — per-call arg overrides env var.
- **`src/api/errors.ts`** — `ApiError extends McpToolError` plus 8 subclasses keyed off the canonical error `code` enum (UNAUTHORIZED, SUBMISSION_NOT_FOUND, RATE_LIMIT_EXCEEDED, etc.). `apiErrorResult(err)` formats CallToolResult with `Error [<code>]: <message>` and `isError: true`.
- **`src/api/config.ts`** — env helpers: `getApiBaseUrl()` (default `https://app.threat.zone/public-api`, strips trailing slash), `getApiToken(override?)`.
- **`src/api/tools/`** — one file per logical endpoint group: `account.ts`, `config.ts`, `submission-browse.ts`, `submission-analysis.ts`, `submission-threat.ts`, `submission-dynamic.ts`, `submission-scan.ts`, `submission-network.ts`, `submission-url.ts`, `downloads.ts`, `submit.ts`. All tool names are `tz_*` prefixed (collision-free with VNC/RTC names).

## Landmines

- **`rfb2` has no published types.** `src/vnc/protocol/rfb2.d.ts` is hand-written from runtime inspection. If upgrading `rfb2`, verify augmented properties (`redShift`, `greenShift`, `blueShift`, `bpp`, `depth`) at runtime.
- **`skipLibCheck: true` is load-bearing** — removing it breaks the build due to `rfb2` lacking proper type exports. RTC code also relies on it because `@roamhq/wrtc`'s type re-exports assume `lib.dom`, which we don't load.
- **Stdout is the MCP transport when `MCP_TRANSPORT=stdio`.** Any `console.log()` corrupts the protocol stream in stdio mode. The codebase uses `console.error()` for debug output everywhere — keep doing that, since the server can be flipped back to stdio at any time and a stray `console.log` would only surface then.
- **Framebuffer assumes little-endian** pixel layout. Big-endian VNC servers will produce garbled screenshots.
- **The container cannot write to `/app`.** The image runs as uid 10001 and `/app` stays owned by root. Do not add code that writes next to the app files.
- **`ffmpeg` and `ffprobe` must be on PATH** for the RTC transport — screenshots spawn them as child processes to decode H.264 → PNG/JPEG and to probe stream dimensions at connect time. Without them, an RTC session fails at the "first frame decoded" step.
- **H.264 only.** The Android gateway never sends an SDP answer to offers that don't advertise H.264 — silently. That's why the project uses `werift` (pure-JS, can offer H.264) instead of `@roamhq/wrtc` (no H.264). Don't swap libraries back without verifying the codec list.
- **Tool args use VNC pixel coordinates.** `RtcClient.sendPointer()` divides by `screenSize.width/height` internally — but `screenSize` only becomes non-null after the first video frame. Calling input tools before the connect promise resolves will throw "Screen size unknown".
- **`device_button` reliability is gateway-dependent.** The JSON message (`{type: 'back'|'home'|'power'}`) matches the browser RTCSession (`apps/novnc/vnc/www/core/rtc-session.js:273-284`) byte-for-byte, but Android launchers may override or no-op these. If a button has no visible effect, check the gateway's signaling-server logs first (each press is logged to MCP stderr as `[rtc][ctrl] device_button: …`); don't assume the MCP side is broken.

## Environment variables

Loaded from `.env` via `dotenv/config` at startup. See `.env.example` for the canonical template.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP) or `stdio` (local CLI) |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP listener bind address; flip to `0.0.0.0` only behind a reverse proxy |
| `MCP_HTTP_PORT` | `7860` | HTTP listener port (route is always `/mcp`, plus `/healthz`) |
| `VNC_CONNECT_TIMEOUT` | `10000` ms | Connection timeout |
| `VNC_SCREENSHOT_TIMEOUT` | `5000` ms | Framebuffer update timeout |
| `RTC_CONNECT_TIMEOUT` | `15000` ms | RTC signaling + first-frame timeout |
| `THREATZONE_API_TOKEN` | — | API token for Public API (required when any API tool is invoked). Per-tool `api_token` arg overrides. |
| `THREATZONE_API_BASE_URL` | `https://app.threat.zone/public-api` | API base URL. |