# Threat.Zone MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Official [Threat.Zone](https://threat.zone) MCP (Model Context Protocol) server. Provides VNC computer-use capabilities — screenshots, keyboard/mouse control, clipboard access, and file transfer — enabling AI agents to interact with remote desktops in Threat.Zone sandbox environments.

## Features

- **Multiple VNC backends** — auto-selects between RFB (None/VNC-Auth), RSA-AES, and VeNCrypt/TLS based on server security type
- **WebSocket proxy support** — connect through websockify proxies for browser-accessible VNC
- **Redis token resolution** — resolve session tokens to VNC targets via Redis
- **Multi-session** — manage multiple concurrent VNC connections with named sessions
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
| `REDIS_URL` | *(disabled)* | Redis connection string for token-based session resolution |
| `VNC_CONNECT_TIMEOUT` | `10000` | Connection timeout in milliseconds |
| `VNC_SCREENSHOT_TIMEOUT` | `5000` | Framebuffer update timeout in milliseconds |
| `VNC_DEFAULT_PORT` | `5901` | Default VNC port when not specified in token data |

## Tools Reference

### Connection

| Tool | Description |
|---|---|
| `connect` | Connect to a VNC server via direct host:port, WebSocket URL, or Redis token |
| `disconnect` | Disconnect from a VNC session |

**`connect` parameters:**

| Parameter | Type | Description |
|---|---|---|
| `host` | string | VNC server hostname or IP |
| `port` | number | VNC server port (default: 5901) |
| `ws_url` | string | WebSocket URL for websockify proxy |
| `ws_cookie` | string | Cookie header for authenticated WebSocket connections |
| `token` | string | Session token resolved via Redis (`vnc-<token>` key) |
| `username` | string | Username for VeNCrypt/RSA-AES authentication |
| `password` | string | VNC authentication password |
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

### Direct connection

```
connect(host: "192.168.1.100", port: 5901, password: "secret")
```

### WebSocket proxy (websockify)

```
connect(ws_url: "wss://app.threat.zone/cloudvnc?token=UUID", ws_cookie: "sessionid=...")
```

### Redis token resolution

Requires `REDIS_URL` to be set. Looks up `vnc-<token>` key in Redis, expecting JSON with `host` and optionally `port`.

```
connect(token: "session-uuid")
```

## Architecture

```
src/
├── index.ts              # Orchestrator: creates McpServer, registers domains, starts stdio transport
├── shared/
│   └── errors.ts         # McpToolError base class
└── vnc/
    ├── register.ts       # registerVncTools(server) — all 15 tool registrations
    ├── errors.ts         # VNC-specific error classes
    ├── tools/            # One handler file per MCP tool
    ├── protocol/         # VNC protocol layer (rfb2, RSA-AES, VeNCrypt backends)
    └── redis/            # Token resolver
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
