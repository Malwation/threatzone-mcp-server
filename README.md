# Threat.Zone MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/tz-gif.gif" alt="Threat.Zone MCP server walkthrough — submitting a sample, reading the verdict, and driving the live sandbox VM" />
</p>

Official [Threat.Zone](https://threat.zone) Model Context Protocol server. Wraps the Threat.Zone malware-analysis platform — submission, reporting, and IOCs — and adds VNC computer-use against the live sandbox VM, so an agent can drive a detonation interactively while the analysis is running.

<use_case>
Use this MCP server when an agent needs to:
- Submit files or URLs to Threat.Zone for static, sandbox, CDR, URL, or open-in-browser analysis
- Read submission verdicts, indicators, IoCs, network traffic, MITRE ATT&CK mappings, dropped artifacts, YARA hits, or signatures
- Drive the live sandbox VM (screenshot, mouse, keyboard, clipboard, file transfer) during dynamic analysis
- Download original samples, PCAPs, generated YARA rules, HTML reports, or dropped-file artifacts
</use_case>

<important_notes>
1. **`THREATZONE_API_TOKEN` is required** for every `tz_*` tool. Issue one from your workspace's API Keys page in the Threat.Zone UI. Set it on the server, or pass `api_token` per call.
2. **Submit tools consume plan quota.** Each `tz_submit_*` call counts against your workspace's daily submission quota — call them intentionally.
3. **Sandbox VMs are short-lived.** A run lives only for the configured `timeout` (default 120 s, max 300 s). Connect VNC and finish interaction inside that window — sessions tear down with the analysis.
4. **Default to private submissions** when handling user-supplied samples (`private: true`), unless the user explicitly opts into public sharing.
5. **Polling is the caller's job.** Submit tools return the UUID immediately; poll status with `tz_submission_get`. Never inline-poll inside another tool.
6. **No tool auto-paginates.** Pass `page` (or `skip` for `tz_network_*`) to walk forward through results.
</important_notes>

---

## Features

- **48 API tools** wrapping the full [Threat.Zone Public API](https://app.threat.zone/public-api/guide) — full read + write surface
- **16 VNC computer-use tools** — screenshot, keyboard, mouse, clipboard, file transfer, all driving the live sandbox VM during dynamic analysis
- **Auto-routing connect** — paste any URL shape (UUID, submission page, cloudvnc, ws/wss); the server probes `/api/token-info` and picks VNC websockify or WebRTC signaling automatically
- **Multi-backend VNC** — auto-selects RFB (None / VNC-Auth), RSA-AES (RA2/RA2ne), or VeNCrypt/TLS based on server security type
- **Streamable HTTP transport** by default — one process serves multiple agents concurrently; flip to `stdio` for single-shot CLI debugging
- **WebRTC backend** for Android sandbox sessions (H.264, werift)

---

## Connecting to MCP clients

The server defaults to **Streamable HTTP** at `https://app.threat.zone/mcp`. Any MCP-compliant client that speaks Streamable HTTP can connect; the snippets below cover the common ones.

### Claude Code (CLI)

```bash
claude mcp add threatzone --transport http https://app.threat.zone/mcp
```

Restart your Claude Code session. `/mcp` should list the server with all tools available.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Stdio is simplest for desktop:

```json
{
  "mcpServers": {
    "threatzone": {
      "command": "node",
      "args": ["/absolute/path/to/threatzone-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "THREATZONE_API_TOKEN": "tz_..."
      }
    }
  }
}
```

### Codex / Cursor / Cline / Windsurf / generic Streamable HTTP

Any client that supports the Streamable HTTP MCP transport can point at the same `/mcp` URL. The exact config field name varies by client; the URL to use is:

```
https://app.threat.zone/mcp
```

For clients that prefer stdio, run with `MCP_TRANSPORT=stdio` and let the client spawn `node dist/index.js`.

### Health check

```bash
curl -s https://app.threat.zone/mcp/healthz   # → 200 OK
```

---

## Tools

The server exposes two tool families: **`tz_*`** (Public API) and **unprefixed** (VNC computer-use). All tools are listed below; see the per-tool description in `tools/list` for full schemas.

### VNC: connection & session control

<use_case>
Use these to attach to (and detach from) a live sandbox VM. The `connect` tool accepts any URL shape — submission UUID, submission page URL, cloudvnc URL, or raw ws/wss — and normalizes them all to the right transport. After a submit you have ~120–300 s before the VM tears down; spend that budget wisely.
</use_case>

| Tool | Description |
|---|---|
| `connect` | Connect by submission UUID, submission page URL, cloudvnc URL, or raw ws/wss URL |
| `disconnect` | Disconnect a session |

### VNC: screen

| Tool | Description |
|---|---|
| `screenshot` | PNG/JPEG capture, optional region cropping and JPEG quality |
| `get_screen_size` | Current screen dimensions |
| `wait_for_screen_change` | Block until screen content changes or timeout — useful for waiting on UI updates |

### VNC: keyboard & mouse

<important_notes>
- `send_key` accepts key names (`Return`, `F1`, `a`), hex keysyms (`0xff0d`), and modifiers (`ctrl`, `alt`, `shift`, `super`, `meta`). On macOS sandbox VMs, **Cmd is `super`** — `meta` aliases to it.
- `type_text` brackets shifted ASCII chars (`[A-Z!$%^&*()_+{}:<>?]`) with `Shift_L`. Five chars (`~ | " @ #`) are not bracketed because they sit on different physical keys between US and UK ANSI layouts; for those, prefer `clipboard_write` + paste.
- `mouse_drag` supports bezier control points for curved paths.
</important_notes>

| Tool | Description |
|---|---|
| `send_key` | Send one key with optional modifiers |
| `type_text` | Type a string character by character |
| `mouse_click` | Single or double click, left/middle/right |
| `mouse_move` | Move cursor without clicking |
| `mouse_drag` | Drag from start to end with optional bezier curve |
| `scroll` | Wheel scroll up/down/left/right at coordinates |

### VNC: clipboard & file transfer

| Tool | Description |
|---|---|
| `clipboard_write` | Send text to remote clipboard (UTF-8 with Extended Clipboard, Latin-1 fallback) |
| `clipboard_read` | Read the last clipboard text received from the remote |
| `file_upload` | Upload a base64 file to the remote (Windows PowerShell or Linux bash + xclip) |
| `file_download` | Download a remote file as base64 (Windows or Linux) |

### VNC: Android-only

| Tool | Description |
|---|---|
| `device_button` | Press a physical Android button (`back`, `home`, `power`) — RTC sessions only |

---

### API: account & config

<use_case>
Call these to discover what the workspace can do *before* picking a sandbox environment, network config, or metafield set. `tz_me` exposes plan quota and enabled modules; `tz_config_environments` lists the OS keys you can pass to `tz_submit_sandbox`.
</use_case>

| Tool | Description |
|---|---|
| `tz_me` | Account, workspace, plan limits, enabled modules |
| `tz_config_environments` | Available sandbox OS environments (Windows / Linux / macOS / Android) |
| `tz_config_metafields` | All metafield options across all submission types |
| `tz_config_metafields_sandbox` | Sandbox-specific metafield options |
| `tz_config_metafields_static` | Static analysis metafield options |
| `tz_config_metafields_cdr` | CDR metafield options |
| `tz_config_metafields_url` | URL analysis metafield options |
| `tz_config_metafields_open_in_browser` | Open-in-browser metafield options |
| `tz_network_configs_list` | Workspace network configs (proxy/VPN profiles for `configurations.networkConfig`) |

### API: submission browse

<use_case>
Use `tz_submissions_list` to scan a workspace's recent submissions with filters (verdict level, type, date range, tags). Use `tz_submission_get` once you have a UUID, and `tz_submission_search_sha256` when the user gives you a hash and you need to know whether it's been seen before.
</use_case>

| Tool | Description |
|---|---|
| `tz_submissions_list` | Paginated list with filters (level, type, sha256, filename, tags, dates). Uses `page`/`limit`. |
| `tz_submission_get` | Get a single submission by UUID — verdict, hashes, per-module status |
| `tz_submission_search_sha256` | Find submissions by exact SHA256 (across your workspace + public). Flat array, no pagination. |

### API: analysis reports

<use_case>
Once you have a UUID, `tz_submission_summary` gives the rollup. Drill in with `tz_submission_indicators` (heuristic signals), `tz_submission_iocs` (atomic IoCs), `tz_submission_artifacts` (dropped files / memory dumps / PCAP refs), `tz_submission_yara_rules` (YARA hits), `tz_submission_mitre` (ATT&CK mappings), `tz_submission_extracted_configs` (parsed C2/family config).
</use_case>

| Tool | Description |
|---|---|
| `tz_submission_summary` | High-level verdict rollup across all modules |
| `tz_submission_indicators` | Paginated behavioural indicators (filterable by level, category, PID, ATT&CK code) |
| `tz_submission_iocs` | Paginated IoCs (domains, IPs, URLs, hashes, registry keys, file paths) |
| `tz_submission_yara_rules` | Paginated YARA rule hits |
| `tz_submission_artifacts` | Full artifact list (no pagination) |
| `tz_submission_mitre` | MITRE ATT&CK technique mappings |
| `tz_submission_extracted_configs` | Extracted malware configuration data |
| `tz_submission_eml_analysis` | EML/MSG email analysis (email submissions only) |

### API: dynamic analysis

| Tool | Description |
|---|---|
| `tz_submission_processes` | Process list captured during dynamic analysis |
| `tz_submission_process_tree` | Process spawn tree (parent–child relationships) |
| `tz_submission_behaviours` | Paginated behaviour events (file/registry/network/process/mutex) |
| `tz_submission_syscalls` | Paginated syscall trace (default `limit=500`) |

### API: network sub-reports

<important_notes>
Network sub-reports use **`limit`/`skip`** offset pagination — *not* `page`/`limit`. Pass `skip: N` to advance. Mixing the two pagination styles is the most common integration bug.
</important_notes>

| Tool | Description |
|---|---|
| `tz_network_summary` | Per-protocol counts and threat rollup |
| `tz_network_dns` | DNS query/response records |
| `tz_network_http` | HTTP request/response records |
| `tz_network_tcp` | TCP connection records |
| `tz_network_udp` | UDP connection records |
| `tz_network_threats` | Suricata-style network threat detections |

### API: specialised reports

| Tool | Description |
|---|---|
| `tz_submission_static_scan` | Static analysis scan results per artifact (PE info, strings, sections, imports/exports) |
| `tz_submission_signature_check` | Code-signing signature verification per artifact |
| `tz_submission_cdr` | CDR analysis metadata (use `tz_download_cdr` for the sanitized file itself) |
| `tz_submission_url_analysis` | Full URL analysis report (URL submissions only) |
| `tz_submission_media_list` | List media files (screenshots, video) captured during dynamic analysis |

### API: downloads

<important_notes>
Binary downloads return base64 inline up to **25 MB**. For larger payloads (PCAPs, HTML reports), pass `save_to: "/absolute/path"` — the response then carries `{ saved, path, size, mimetype }` only, keeping the JSON-RPC frame small. Original samples come down as a password-protected ZIP; the password is `infected` (industry standard for malware sandboxing).
</important_notes>

| Tool | Description |
|---|---|
| `tz_download_sample` | Original sample as password-protected ZIP (password: `infected`) |
| `tz_download_artifact` | Specific artifact by ID (get IDs from `tz_submission_artifacts`) |
| `tz_download_pcap` | Network capture (PCAP) |
| `tz_download_yara_rule` | Generated YARA rule file |
| `tz_download_html_report` | Full HTML analysis report |
| `tz_download_cdr` | CDR-sanitized output file |
| `tz_download_screenshot` | URL-analysis screenshot (PNG; URL submissions only) |
| `tz_download_media` | Media file from dynamic analysis by file ID (get from `tz_submission_media_list`) |

### API: submit

<use_case>
Use these to create new analyses. `tz_submit_sandbox` is the heaviest (full static + dynamic, consumes one daily slot); `tz_submit_static` is fast and skips the VM; `tz_submit_cdr` produces a sanitized version of an Office/PDF document; `tz_submit_url` scrapes and screenshots a URL; `tz_submit_open_in_browser` opens the URL inside a sandboxed browser session you can drive over VNC.
</use_case>

<important_notes>
1. **Pass `private: true`** unless the user has explicitly authorised public sharing.
2. **Submit tools return the UUID and exit.** Poll status with `tz_submission_get` — do not block.
3. **`file_base64` is the entire file** as a single base64 string. For archive submissions, pass `entrypoint` to point at the file inside.
4. **`tz_submit_sandbox` accepts `metafields`** to override defaults (e.g. `{"timeout": 300}` for the maximum 5-minute window). Discover available keys with `tz_config_metafields_sandbox`.
</important_notes>

| Tool | Description |
|---|---|
| `tz_submit_sandbox` | Full sandbox analysis (static + dynamic). Returns UUID; poll with `tz_submission_get`. |
| `tz_submit_static` | Static-only analysis (faster, no VM) |
| `tz_submit_cdr` | Content Disarm & Reconstruction — produces sanitized output |
| `tz_submit_url` | URL analysis (crawler + cert + redirect chain + threat lists) |
| `tz_submit_open_in_browser` | Open URL inside a sandboxed browser session |

---

## Connection URL shapes

The single `url` argument to `connect` accepts every shape below; the server normalizes each to a canonical websockify URL (`wss://<host>/cloudvnc?token=<UUID>`) and connects.

### Submission UUID (defaults to `app.threat.zone`)

```
connect(url: "9a6f8a57-b9d8-4372-b600-f4d196f5da43")
# → wss://app.threat.zone/cloudvnc?token=9a6f8a57-b9d8-4372-b600-f4d196f5da43
```

### Submission page URL (trailing path stripped)

```
connect(url: "https://app.threat.zone/submission/9a6f8a57-.../dynamic-scan-report")
# → wss://app.threat.zone/cloudvnc?token=9a6f8a57-...
```

### CloudVNC URL (probes `/api/token-info` to route VNC vs WebRTC)

```
connect(url: "https://app.threat.zone/cloudvnc?token=UUID")
```

### ws:// or wss:// URL (`ws://` is auto-upgraded)

```
connect(url: "ws://app.threat.zone/cloudvnc?token=UUID")
# → wss://app.threat.zone/cloudvnc?token=UUID
```

### Raw websockify URL with cookie (legacy `ws_url` arg)

```
connect(ws_url: "wss://app.threat.zone/?token=UUID", ws_cookie: "sessionid=...")
```

---

## Architecture

```
src/
├── index.ts              # Orchestrator: picks transport, wires registerVncTools + registerApiTools
├── shared/               # RemoteSession interface + McpToolError base
├── api/                  # Public API tools (48: 43 read-only + 5 submit)
├── vnc/                  # VNC computer-use (16 tools, auto-detected backend)
│   └── protocol/         # rfb2, RSA-AES, VeNCrypt backends
└── rtc/                  # WebRTC client for Android device gateways (werift, H.264)
```

The VNC client auto-detects the right backend by probing the server's supported security types:

- **RFB** — None (1) and VNC-Auth (2) via `rfb2`
- **RSA-AES** — RA2 / RA2ne (5, 6, 13, 129, 133)
- **VeNCrypt** — TLS-wrapped authentication (19)

For the deeper architectural spec (session model, landmines, transport quirks), read `CLAUDE.md`.

---

## Development

| Command | Description |
|---|---|
| `yarn run build` | Compile TypeScript to `dist/` |
| `yarn run start` | Run compiled server |
| `yarn run start:dev` | Run from source via ts-node (no watch — restart manually) |
| `yarn run check` | Lint and format check (Biome) |
| `yarn run check:write` | Lint and auto-fix |
| `yarn test` | Jest (no tests yet — passes vacuously) |

See `CONTRIBUTING.md` for the full contributor workflow.

---

## License

[MIT](LICENSE)
