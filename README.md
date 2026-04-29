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
| `THREATZONE_API_TOKEN` | _(required for API tools)_ | API token for the Threat.Zone Public API; per-tool `api_token` arg overrides this |
| `THREATZONE_API_BASE_URL` | `https://app.threat.zone/public-api` | Override the API base URL (e.g. for on-prem) |
| `THREATZONE_ALLOW_SUBMIT` | `false` | Set to `true` to enable submit tools (POST endpoints consume plan quota) |

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

## API Tools

The server wraps the full [Threat.Zone Public API](https://app.threat.zone/public-api/guide) (v3.2.0, 48 endpoints). Set `THREATZONE_API_TOKEN` and optionally `THREATZONE_API_BASE_URL` to use these tools. Every tool also accepts an optional `api_token` argument to override the env var on a per-call basis.

> **Read-only by default.** Submit tools (POST endpoints) are only registered when `THREATZONE_ALLOW_SUBMIT=true`. Each submit call consumes daily plan quota — set this intentionally.

### Account & Config

| Tool | Description |
|---|---|
| `tz_me` | Get account info, workspace, plan limits, and enabled modules |
| `tz_config_metafields` | All metafield options across all submission types |
| `tz_config_metafields_sandbox` | Sandbox-specific metafield options |
| `tz_config_metafields_static` | Static analysis metafield options |
| `tz_config_metafields_cdr` | CDR metafield options |
| `tz_config_metafields_url` | URL analysis metafield options |
| `tz_config_metafields_open_in_browser` | Open-in-browser metafield options |
| `tz_config_environments` | Available sandbox OS environments |
| `tz_network_configs_list` | Workspace network configurations (proxy/VPN profiles) |

### Submission Browse

| Tool | Description |
|---|---|
| `tz_submissions_list` | Paginated list with filters (level, type, sha256, filename, tags, dates) — uses `page`/`limit` |
| `tz_submission_get` | Get a single submission by UUID |
| `tz_submission_search_sha256` | Find submissions by exact SHA256 hash (returns flat array, no pagination) |

### Analysis Reports

| Tool | Description |
|---|---|
| `tz_submission_summary` | High-level verdict rollup across all analysis modules |
| `tz_submission_indicators` | Paginated behavioural indicators (filterable by level, category, PID, ATT&CK code) |
| `tz_submission_iocs` | Paginated IoCs (domains, IPs, URLs, hashes, registry keys, file paths) |
| `tz_submission_yara_rules` | Paginated YARA rule hits |
| `tz_submission_artifacts` | Full artifact list (no pagination) |
| `tz_submission_mitre` | MITRE ATT&CK technique mappings |
| `tz_submission_extracted_configs` | Extracted malware configuration data |
| `tz_submission_eml_analysis` | EML email analysis (email submissions only) |

### Dynamic Analysis

| Tool | Description |
|---|---|
| `tz_submission_processes` | Process list captured during dynamic analysis |
| `tz_submission_process_tree` | Process spawn tree (parent–child relationships) |
| `tz_submission_behaviours` | Paginated behaviour events (file/registry/network/process/mutex) |
| `tz_submission_syscalls` | Paginated syscall trace (default `limit=500`) |

### Network Analysis

All paginated network sub-reports use `limit`/`skip` offset pagination — NOT `page`/`limit`.

| Tool | Description |
|---|---|
| `tz_network_summary` | Network activity summary (per-protocol counts) |
| `tz_network_dns` | DNS query/response records |
| `tz_network_http` | HTTP request/response records |
| `tz_network_tcp` | TCP connection records |
| `tz_network_udp` | UDP connection records |
| `tz_network_threats` | Suricata-style network threat detections |

### Specialised Reports

| Tool | Description |
|---|---|
| `tz_submission_static_scan` | Static analysis scan results per artifact |
| `tz_submission_cdr` | CDR analysis metadata (use `tz_download_cdr` for the sanitized file) |
| `tz_submission_signature_check` | Code-signing signature verification |
| `tz_submission_url_analysis` | Full URL analysis report (URL submissions only) |
| `tz_submission_media_list` | List media files captured during dynamic analysis |

### Downloads

Binary responses are returned as base64 (max 25 MB inline). Use `save_to: "/absolute/path"` to write larger files directly to disk; the response then carries only `{ saved, path, size, mimetype }`.

| Tool | Description |
|---|---|
| `tz_download_sample` | Download original sample as password-protected ZIP (password: `infected`) |
| `tz_download_artifact` | Download a specific artifact by ID (from `tz_submission_artifacts`) |
| `tz_download_pcap` | Download network capture (PCAP) |
| `tz_download_yara_rule` | Download generated YARA rule file |
| `tz_download_html_report` | Download full HTML analysis report |
| `tz_download_cdr` | Download CDR-sanitized output file |
| `tz_download_screenshot` | Download URL analysis screenshot (PNG) |
| `tz_download_media` | Download a media file from dynamic analysis by file ID |

### Submit (gated — requires `THREATZONE_ALLOW_SUBMIT=true`)

| Tool | Description |
|---|---|
| `tz_submit_sandbox` | Submit a file for full sandbox (static + dynamic) analysis |
| `tz_submit_static` | Submit a file for static analysis only |
| `tz_submit_cdr` | Submit a file for CDR (Content Disarm & Reconstruction) |
| `tz_submit_url` | Submit a URL for URL analysis |
| `tz_submit_open_in_browser` | Submit a URL to open in a sandboxed browser |

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
