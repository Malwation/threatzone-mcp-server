# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The official Threat.Zone MCP (Model Context Protocol) server. Provides VNC and WebRTC computer-use capabilities (screenshots, keyboard/mouse control, clipboard on VNC, file transfer on VNC, Android device buttons on RTC) over stdio transport. Structured as a multi-domain server where each feature domain (VNC, RTC, future APIs) is self-contained but shares a `RemoteSession` interface that tool handlers consume.

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
- **`redis/`** — `TokenResolver` resolves session tokens to host:port via Redis keys (`vnc-<token>`). Only active when `REDIS_URL` is set.
- **`errors.ts`** — `VncError` (extends `McpToolError` from `src/shared/errors.ts`) plus domain-specific error subclasses.
- **`tools/connect.ts`** — central dispatch. The `url` mode probes `/api/token-info` first (`protocol/token-info.ts`); on `type:vnc` it routes through websockify, on `type:webrtc` it constructs an `RtcClient` and registers it via `SessionManager.register()`. Legacy `token`/`ws_url`/`host:port` modes are kept for back-compat.

### RTC domain (`src/rtc/`)

WebRTC client for driving Android device gateways through the novnc `/webrtc-signal` proxy. Uses **`werift`** (pure-JS WebRTC) so the offer can advertise H.264 — the only codec the Android gateway answers. Earlier attempts with `@roamhq/wrtc` failed silently because it ships VP8/VP9/AV1 only, no H.264 → no codec overlap → no SDP answer.

- **`protocol/rtc-client.ts`** — `RtcClient implements RemoteSession`. On `connect()`: opens signaling, creates `RTCPeerConnection({ codecs: { video: [H264 baseline] } })`, declares a `control` data channel + recvonly video transceiver, exchanges offer/answer/ICE, waits for data channel + first decoded keyframe (so `screenSize` is populated before any input call). Whole sequence is bounded by an overall `RTC_CONNECT_TIMEOUT` budget; signaling close/error/PC failure rejects every in-flight handshake step via a shared `bail` rejector.
- **`protocol/signaling.ts`** — WebSocket signaling client for `/webrtc-signal`. Three JSON message types: outbound offer/ice, inbound answer/ice. Uses `rejectUnauthorized: false` (mirrors `vnc/protocol/ws-transport.ts`).
- **`protocol/control-channel.ts`** — JSON encoder for the `control` data channel: `touch`/`key`/`scroll`/device-button messages. Coordinates are normalized [0..1].
- **`protocol/keysym-to-code.ts`** — reverse map from X11 keysyms → DOM `KeyboardEvent.code`. Auto-shifts uppercase letters and shifted ASCII punctuation by wrapping with `ShiftLeft` press/release, so `type_text("Hello!")` works without explicit modifiers.
- **`protocol/h264-decoder.ts`** — H.264 RTP depacketizer (wraps `werift.H264RtpPayload`), Annex-B NAL splitter, and ffmpeg child-process wrappers (`decodeH264ToImage`, `probeH264Dimensions`).
- **`protocol/video-sink.ts`** — collects depacketized NAL units into a rolling GOP anchored on the latest IDR (with the most recent SPS/PPS prepended on every keyframe). `frameToImage()` pipes the GOP into `ffmpeg -f h264 -frames:v 1 -update 1 -f image2 -vcodec png pipe:1`.
- **`errors.ts`** — `RtcError`, `RtcConnectionError`, `RtcSignalingError`, `UnsupportedOnTransportError`.

## Landmines

- **`rfb2` has no published types.** `src/vnc/protocol/rfb2.d.ts` is hand-written from runtime inspection. If upgrading `rfb2`, verify augmented properties (`redShift`, `greenShift`, `blueShift`, `bpp`, `depth`) at runtime.
- **`skipLibCheck: true` is load-bearing** — removing it breaks the build due to `rfb2` lacking proper type exports. RTC code also relies on it because `@roamhq/wrtc`'s type re-exports assume `lib.dom`, which we don't load.
- **Stdout is the MCP transport.** Any `console.log()` corrupts the protocol stream. Use `console.error()` for debug output only.
- **Framebuffer assumes little-endian** pixel layout. Big-endian VNC servers will produce garbled screenshots.
- **`ffmpeg` and `ffprobe` must be on PATH** for the RTC transport — screenshots spawn them as child processes to decode H.264 → PNG/JPEG and to probe stream dimensions at connect time. Without them, `connect(url:…)` for a webrtc token will fail at the "first frame decoded" step.
- **H.264 only.** The Android gateway never sends an SDP answer to offers that don't advertise H.264 — silently. That's why the project uses `werift` (pure-JS, can offer H.264) instead of `@roamhq/wrtc` (no H.264). Don't swap libraries back without verifying the codec list.
- **Tool args use VNC pixel coordinates.** `RtcClient.sendPointer()` divides by `screenSize.width/height` internally — but `screenSize` only becomes non-null after the first video frame. Calling input tools before the connect promise resolves will throw "Screen size unknown".
- **`device_button` reliability is gateway-dependent.** The JSON message (`{type: 'back'|'home'|'power'}`) matches the browser RTCSession (`apps/novnc/vnc/www/core/rtc-session.js:273-284`) byte-for-byte, but Android launchers may override or no-op these. If a button has no visible effect, check the gateway's signaling-server logs first (each press is logged to MCP stderr as `[rtc][ctrl] device_button: …`); don't assume the MCP side is broken.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | `null` (disables token connect) | Redis connection string for token resolution |
| `VNC_CONNECT_TIMEOUT` | `10000` ms | Connection timeout |
| `VNC_SCREENSHOT_TIMEOUT` | `5000` ms | Framebuffer update timeout |
| `VNC_DEFAULT_PORT` | `5901` | Fallback port for token-resolved targets |
| `RTC_CONNECT_TIMEOUT` | `15000` ms | RTC signaling + first-frame timeout |
