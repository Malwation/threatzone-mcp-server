# Threat.Zone MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Official [Threat.Zone](https://threat.zone) MCP (Model Context Protocol) server. Provides VNC computer-use capabilities — screenshots, keyboard/mouse control, clipboard access, and file transfer — enabling AI agents to interact with remote desktops in Threat.Zone sandbox environments.

## Features

- **Multiple VNC backends** — auto-selects between RFB (None/VNC-Auth), RSA-AES, and VeNCrypt/TLS based on server security type
- **CloudVNC URL connect** — paste a `https://app.threat.zone/cloudvnc?token=...` URL; the server probes `/api/token-info` and routes to VNC websockify or WebRTC signaling automatically
- **Multi-session** — manage multiple concurrent VNC/RTC connections with named sessions
- **Screenshot capture** — PNG/JPEG with optional region cropping and quality control
- **Full input control** — keyboard (key names, keysyms, modifiers), mouse (click, move, drag with bezier curves, scroll)
- **Clipboard access** — read/write remote clipboard (UTF-8 with Extended Clipboard support)
- **File transfer** — upload/download files via clipboard + shell commands (Windows & Linux)

## Installation

```bash
yarn install
yarn build
```

## Usage

The server communicates over **stdio transport**. Add it to your MCP client configuration:

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "threatzone-mcp": {
      "command": "node",
      "args": ["/path/to/threatzone-mcp-server/dist/index.js"],
      "env": {
        "REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

### Running directly

```bash
# From compiled output
node dist/index.js

# From source (development)
yarn start:dev
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VNC_CONNECT_TIMEOUT` | `10000` | Connection timeout in milliseconds |
| `VNC_SCREENSHOT_TIMEOUT` | `5000` | Framebuffer update timeout in milliseconds |
| `RTC_CONNECT_TIMEOUT` | `15000` | RTC signaling + first-frame timeout in milliseconds |

## Tools Reference

### Connection

| Tool | Description |
|---|---|
| `connect` | Connect to a Threat.Zone session by cloudvnc URL or raw websockify URL |
| `disconnect` | Disconnect from a session |

**`connect` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `url` | string | Cloudvnc URL with embedded token (e.g. `https://app.threat.zone/cloudvnc?token=UUID`). Probes `/api/token-info` to route VNC vs. WebRTC. |
| `ws_url` | string | Raw websockify URL when you already have one (e.g. `wss://host:9191/?token=UUID`). Skips the token-info probe. |
| `ws_cookie` | string | Cookie header for authenticated websockify connections (paired with `ws_url`) |
| `session_id` | string | Custom session identifier |

### Screen

| Tool | Description |
|---|---|
| `screenshot` | Capture screen as PNG or JPEG, with optional region cropping and quality setting |
| `get_screen_size` | Get the current screen dimensions (width x height) |
| `wait_for_screen_change` | Wait until screen content changes or timeout (useful for waiting on UI updates) |

### Keyboard

| Tool | Description |
|---|---|
| `send_key` | Send a key press/release. Supports key names (`Return`, `F1`, `a`), hex keysyms (`0xff0d`), and modifiers (`ctrl`, `alt`, `shift`, `super`, `meta`) |
| `type_text` | Type a string character by character with configurable delay between keystrokes |

### Mouse

| Tool | Description |
|---|---|
| `mouse_click` | Click at coordinates. Supports left/middle/right button and single/double click |
| `mouse_move` | Move cursor to coordinates |
| `mouse_drag` | Drag between two points with optional bezier curve control points |
| `scroll` | Scroll wheel at coordinates in any direction (up/down/left/right) |

### Clipboard

| Tool | Description |
|---|---|
| `clipboard_write` | Send text to remote clipboard (UTF-8 with Extended Clipboard, Latin-1 fallback) |
| `clipboard_read` | Read the last clipboard text received from the remote machine |

### File Transfer

| Tool | Description |
|---|---|
| `file_upload` | Upload a base64-encoded file to the remote machine via clipboard + shell commands |
| `file_download` | Download a file from the remote machine as base64 via clipboard + shell commands |

Both file transfer tools support Windows (PowerShell) and Linux (bash + xclip) via the `os` parameter.

## Connection Methods

The single `url` argument accepts every shape below — the server normalizes each to a canonical websockify URL (`wss://<host>/cloudvnc?token=<UUID>`) and connects.

### Submission UUID

Paste just the submission UUID. Defaults to `app.threat.zone`:

```
connect(url: "9a6f8a57-b9d8-4372-b600-f4d196f5da43")
# → wss://app.threat.zone/cloudvnc?token=9a6f8a57-b9d8-4372-b600-f4d196f5da43
```

### Submission page URL

Paste the URL from your browser address bar. Trailing path (e.g. `/dynamic-scan-report`) is ignored:

```
connect(url: "https://app.threat.zone/submission/9a6f8a57-b9d8-4372-b600-f4d196f5da43/dynamic-scan-report")
# → wss://app.threat.zone/cloudvnc?token=9a6f8a57-b9d8-4372-b600-f4d196f5da43
```

### CloudVNC URL

Probes `/api/token-info` to route VNC tokens through websockify and WebRTC tokens through `/webrtc-signal`:

```
connect(url: "https://app.threat.zone/cloudvnc?token=UUID")
```

### ws:// or wss:// URL

`ws://` is auto-upgraded to `wss://`; `wss://` is passed through verbatim:

```
connect(url: "ws://app.threat.zone/cloudvnc?token=UUID")
# → wss://app.threat.zone/cloudvnc?token=UUID
```

### Raw websockify URL (legacy `ws_url` arg)

When you need to attach a `Cookie` header for an authenticated websockify connection:

```
connect(ws_url: "wss://app.threat.zone/?token=UUID", ws_cookie: "sessionid=...")
```

## Architecture

```
src/
├── index.ts              # Orchestrator: loads .env, picks transport (HTTP/stdio), wires McpServer
├── shared/               # RemoteSession interface + McpToolError base
├── rtc/                  # WebRTC client for Android device gateways (werift, H.264)
└── vnc/
    ├── register.ts       # registerVncTools(server) — all 16 tool registrations
    ├── errors.ts         # VNC-specific error classes
    ├── tools/            # One handler file per MCP tool
    └── protocol/         # VNC protocol layer (rfb2, RSA-AES, VeNCrypt backends)
```

The server auto-detects the appropriate VNC backend by probing the remote server's supported security types:

- **RFB backend** — None (type 1) and VNC-Auth (type 2) via the `rfb2` library
- **RSA-AES client** — RA2/RA2ne encryption (types 5, 6, 13, 129, 133)
- **VeNCrypt client** — TLS-wrapped authentication (type 19)

## Development

| Command | Description |
|---|---|
| `yarn build` | Compile TypeScript to `dist/` |
| `yarn start` | Run compiled server |
| `yarn start:dev` | Run from source via ts-node (manual restart required) |
| `yarn run check` | Lint and format check with Biome |
| `yarn run check:write` | Lint and auto-fix with Biome |
| `yarn test` | Run tests with Jest |

## License

[MIT](LICENSE)
