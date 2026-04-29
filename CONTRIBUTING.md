# Contributing to threatzone-mcp-server

Practical guide for maintainers and new hires. This document covers local setup, the architecture you'll work in, the patterns to follow when adding features, the rules that exist for non-obvious reasons, and the verification gate every PR has to clear.

If you only have ten minutes, read **[Quick start](#quick-start)** and **[The five hard rules](#the-five-hard-rules)**, then look at one existing tool file in the domain you're touching before you write anything.

---

## Quick start

### 1. Clone, install, build

```bash
git clone <repo-url>
cd threatzone-mcp-server
yarn install
yarn run build
```

Required tooling on PATH: **Node 20+**, **yarn 1.x**, **ffmpeg + ffprobe** (only needed if you'll touch the RTC/Android transport — VNC and API tools work without them).

### 2. Configure

```bash
cp .env.example .env
# edit .env — set THREATZONE_API_TOKEN if you'll exercise the tz_* API tools
```

Minimum env you'll usually want:

```bash
MCP_TRANSPORT=http          # or "stdio" for one-off CLI debugging
MCP_HTTP_HOST=127.0.0.1     # 0.0.0.0 ONLY behind a reverse proxy
MCP_HTTP_PORT=7860
THREATZONE_API_TOKEN=tz_…   # required to invoke any tz_* tool
# THREATZONE_API_BASE_URL=https://staging.threat.zone/public-api  # uncomment to point at staging
# THREATZONE_ALLOW_SUBMIT=true  # uncomment to enable the 5 submit tools (consumes plan quota)
```

`THREATZONE_API_TOKEN` has no default — issue one from your workspace's API keys page in the Threat.Zone UI.

### 3. Run locally

```bash
# HTTP mode (default — what you'll use 99% of the time)
yarn run start            # uses dist/, requires `yarn run build` first
yarn run start:dev        # runs from source via ts-node, no watch — restart manually after changes

# stdio mode (for debugging by piping JSON-RPC frames)
MCP_TRANSPORT=stdio yarn run start
```

The HTTP server listens on `http://127.0.0.1:7860/mcp` (Streamable HTTP transport) plus `/healthz`. Smoke-check it:

```bash
curl -s http://127.0.0.1:7860/healthz   # → 200 OK
```

### 4. Register the local server with your MCP client

For Claude Code:

```bash
claude mcp add threatzone-local --transport http http://127.0.0.1:7860/mcp
```

Then restart your Claude Code session. You should see all 64 tools listed in `/mcp` (16 VNC/RTC + 43 read-only API + 5 submit tools when `THREATZONE_ALLOW_SUBMIT=true`).

For Claude Desktop, edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "threatzone-local": {
      "command": "node",
      "args": ["/absolute/path/to/threatzone-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "THREATZONE_API_TOKEN": "tz_…"
      }
    }
  }
}
```

### 5. Inspect the tool list (no client needed)

Pipe JSON-RPC frames directly to the stdio entry-point:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | MCP_TRANSPORT=stdio THREATZONE_ALLOW_SUBMIT=true node dist/index.js 2>/dev/null \
  | grep -o '"name":"[a-z0-9_]*"' | sort -u
```

This is the same pattern every implementer task uses for verification — keep it in your shell history.

---

## Repository map

```
src/
├── index.ts              # Orchestrator — picks transport, wires registerVncTools + registerApiTools per session
├── shared/
│   ├── remote-session.ts # Interface implemented by VncClient and RtcClient
│   └── errors.ts         # McpToolError base class
├── vnc/                  # VNC + RTC computer-use domain (16 tools)
│   ├── register.ts       # Tool registrations
│   ├── tools/            # One file per tool
│   ├── protocol/         # rfb2/RA2/VeNCrypt backends, Framebuffer, SessionManager, ws-transport
│   └── errors.ts
├── rtc/                  # Android device WebRTC backend (consumed by VNC's `connect` tool)
│   ├── protocol/
│   └── errors.ts
└── api/                  # Public API HTTP wrapper (43 read-only + 5 gated submit = 48 tools)
    ├── register.ts       # Aggregator — calls every tools/<group>.ts register fn
    ├── client.ts         # apiRequest() typed fetch wrapper, error envelope mapping
    ├── config.ts         # getApiBaseUrl / getApiToken / isSubmitAllowed env helpers
    ├── errors.ts         # ApiError + 8 typed subclasses + apiErrorResult helper
    └── tools/            # One file per logical endpoint group (account, config, …, submit)
```

Each domain is self-contained. The only files that "know about" all three are `src/index.ts` (boots them) and `src/shared/` (the contract).

For deeper architecture detail (session model, landmines, transport quirks), read `CLAUDE.md` — same content but written with assumed context, used by AI assistants. Treat that file as the canonical spec; this file is the contributor-facing summary.

---

## The five hard rules

These are real, non-negotiable, and will block your PR.

### 1. `console.error()` only — never `console.log()`

In stdio transport mode, **stdout is the MCP wire**. Any `console.log()` corrupts the JSON-RPC stream and breaks every connected client. The codebase uses `console.error()` for every debug line, including in HTTP mode (consistency, plus the server can be flipped to stdio at any time).

```ts
// ✗ Wrong
console.log('connecting to', url);

// ✓ Right
console.error('[vnc] connecting to', url);
```

The `[domain]` prefix is conventional, not enforced.

### 2. ESM `.js` extension on every relative import

Module resolution is `Node16` / `NodeNext`. TypeScript compiles to ESM. **Source imports must end in `.js`** (the actual `.ts` file is found via the resolver, but the spec requires the `.js` extension at runtime).

```ts
// ✗ Wrong
import { apiRequest } from '../client';
import { handleConnect } from './tools/connect';

// ✓ Right
import { apiRequest } from '../client.js';
import { handleConnect } from './tools/connect.js';
```

The build will pass without the extension, but the runtime will throw `ERR_MODULE_NOT_FOUND`. Biome doesn't catch this — it's on you.

### 3. No `any`, no `@ts-ignore`, no `as any` in production code

Use `unknown` and narrow with type guards or `instanceof`. The `skipLibCheck: true` flag in `tsconfig.json` is load-bearing for two specific dependencies (`rfb2` and `@roamhq/wrtc`); don't take it as license to weaken types in your own code.

```bash
# Verification command — must return zero matches
grep -rE ":\s*any\b|@ts-ignore|as\s+any" src/
```

### 4. Don't touch unrelated domains in feature PRs

`src/vnc/`, `src/rtc/`, `src/shared/`, and `src/api/` are independent. A PR adding a new API tool should not modify VNC files. If you find a bug in another domain while working on yours, open a separate PR — don't bundle.

The only file that legitimately gets touched across domains is `src/index.ts` when wiring a brand new domain.

### 5. The Authorization header value never appears in logs or thrown errors

`api/client.ts` builds the `Bearer <token>` header inside the `headers` dict. Don't log the headers object, don't include the token in error messages, don't print it in debug output. This is a leakage class — keep it watertight.

```bash
# Belt-and-braces grep
grep -rn "Authorization" src/api/   # only one match, in client.ts:117
```

---

## How to add a new feature

Pick the section that matches what you're building.

### Adding a new API tool (most common case)

You're wrapping a new Public API endpoint as a `tz_*` tool. Example: a hypothetical `GET /submissions/{uuid}/threat-actors`.

#### 1. Confirm the endpoint exists in the OpenAPI spec

```bash
curl -s https://staging.threat.zone/public-api/docs-json -o /tmp/spec.json
jq '.paths["/submissions/{uuid}/threat-actors"]' /tmp/spec.json
```

Read `parameters`, `responses[200].content`, and any `$ref` schemas you'll surface in the tool description. Schema correctness is enforced in review — don't guess `.max(100)` if the OpenAPI doesn't have a `maximum` field.

#### 2. Pick (or create) the right `src/api/tools/<group>.ts` file

| Group | Existing file |
|---|---|
| Account / config | `account.ts`, `config.ts` |
| Submission browse | `submission-browse.ts` |
| Per-submission analysis JSON | `submission-analysis.ts`, `submission-threat.ts`, `submission-dynamic.ts`, `submission-scan.ts`, `submission-url.ts` |
| Network sub-reports | `submission-network.ts` |
| Binary downloads | `downloads.ts` |
| Write surface (POST) | `submit.ts` |

If your tool fits a group, append to that file. Only create a new file if the new endpoint is its own logical group.

#### 3. Add the tool

Pattern (read-only GET with optional filters, JSON response):

```ts
server.tool(
  'tz_submission_threat_actors',
  'Returns threat actor mappings observed during analysis. Empty array if none. <when-to-use sentence>.',
  {
    uuid: z.string().describe('Submission UUID'),
    api_token: z.string().optional().describe('Override THREATZONE_API_TOKEN env var for this call'),
  },
  async (args): Promise<CallToolResult> => {
    try {
      const data = await apiRequest({
        path: `/submissions/${args.uuid}/threat-actors`,
        apiToken: args.api_token,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return apiErrorResult(err);
    }
  },
);
```

Conventions for new API tools:

- **Name**: `tz_<domain>_<resource>` snake_case. Existing prefixes: `tz_me`, `tz_config_*`, `tz_submission_*`, `tz_network_*`, `tz_download_*`, `tz_submit_*`. Pick whichever group makes the tool discoverable in the README's tool table.
- **`api_token` arg**: every tool accepts it. Per-call override of `THREATZONE_API_TOKEN`.
- **`uuid` arg**: don't add `.uuid()` or `.regex()` — the API returns `INVALID_UUID` with a useful message; client-side validation is duplicate work.
- **`page` / `limit`**: only if the OpenAPI says so. Match the API's actual constraints (default, min, max). Don't invent caps.
- **`limit` / `skip`** (offset pagination): used **only** by `tz_network_*` tools. Note in the description: `Uses limit/skip offset pagination — NOT page/limit`.
- **Return value**: `JSON.stringify(data, null, 2)` verbatim. Don't transform/filter/normalize the API response.
- **Error handling**: every handler is wrapped in `try { … } catch (err) { return apiErrorResult(err); }`. The typed error subclasses do the right thing automatically — don't catch-and-rethrow with custom messages.
- **No auto-pagination**: tools accept `page`/`limit` and pass through verbatim. Never iterate fetches inside a single tool call.
- **No auto-polling**: submit tools return UUID + message, the LLM polls via `tz_submission_get`.

#### 4. Wire it in

If you added a new file, append to `src/api/register.ts`:

```ts
import { registerThreatActorTools } from './tools/threat-actor.js';
// …
registerThreatActorTools(server);
```

Order in `registerApiTools` is alphabetical-ish but not strict. Keep submit-gated registrations last.

#### 5. Document it

Add a row to the appropriate table in `README.md` "API Tools" section. Match the existing description tone — terse, specific, no marketing.

#### 6. Verify (see [Verification gate](#verification-gate-every-pr-clears-this) below).

### Adding a binary download tool

Use the shared `handleBinaryDownload` helper exported from `src/api/tools/downloads.ts`:

```ts
server.tool(
  'tz_download_thing',
  'Download <thing>. Returns base64 ≤25 MB; pass save_to with an absolute path for larger files.',
  {
    uuid: z.string(),
    api_token: z.string().optional(),
    save_to: z.string().optional().describe('Absolute filesystem path; if omitted, returns base64 (max 25 MB)'),
  },
  async (args): Promise<CallToolResult> => {
    try {
      return await handleBinaryDownload(
        `/submissions/${args.uuid}/download/thing`,
        args.api_token,
        args.save_to,
      );
    } catch (err) {
      return apiErrorResult(err);
    }
  },
);
```

The helper enforces the 25 MB inline cap, handles the `save_to` disk-write branch, and parses the `Content-Disposition` filename for you.

### Adding a write-surface tool (POST)

Submit tools live in `src/api/tools/submit.ts` and are conditionally registered. The first executable line of `registerSubmitTools` is the gate:

```ts
export function registerSubmitTools(server: McpServer): void {
  if (!isSubmitAllowed()) {
    console.error('[api] submit tools disabled (THREATZONE_ALLOW_SUBMIT != "true")');
    return;
  }
  console.error('[api] submit tools ENABLED — write surface active');
  // server.tool(…) calls go here
}
```

Multipart bodies (file upload): build `FormData`, append `file` first, set string fields after. Don't set `Content-Type` manually — `apiRequest` detects `body instanceof FormData` and lets `fetch` set the multipart boundary. JSON bodies: pass a plain object; `apiRequest` JSON-stringifies and sets `Content-Type: application/json`.

```ts
// Multipart example
const formData = new FormData();
formData.append('file', new Blob([Buffer.from(args.file_base64, 'base64')]), args.filename);
if (args.environment) formData.append('environment', args.environment);
const data = await apiRequest({
  path: '/submissions/sandbox',
  method: 'POST',
  body: formData,
  apiToken: args.api_token,
});
```

### Adding a new VNC tool

Pattern in `src/vnc/tools/<tool-name>.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface NewToolArgs {
  session_id?: string;
  // …other args
}

export async function handleNewTool(
  args: NewToolArgs,
  sessionManager: SessionManager,
): Promise<CallToolResult> {
  const client = sessionManager.getSession(args.session_id);
  // call methods on client (RemoteSession interface)
  return { content: [{ type: 'text', text: 'OK' }] };
}
```

Register in `src/vnc/register.ts` with the same `server.tool(name, description, zodSchema, handler)` shape. If the tool is RTC-only (`device_button`-style), implement the method on `RtcClient` only and have `VncClient` throw `UnsupportedOnTransportError`. Tool handlers consume sessions via the shared `RemoteSession` interface — they don't branch on transport.

VNC tool names are **unprefixed** (legacy convention from before the API domain existed). Don't add `tz_` to new VNC tools — that prefix is reserved for the API domain.

### Adding a new domain (rare)

If you're adding a third major capability area (e.g. a Threat.Zone subscription/WebSocket client), create `src/<domain>/` with the same shape as `src/api/` (`register.ts`, `errors.ts`, `tools/`), and add **two** lines to `src/index.ts`:

1. `import { registerXxxTools } from './<domain>/register.js';` at the top
2. `registerXxxTools(server);` in **both** `startStdio` and `startHttp` (after the existing register calls)

Both boot paths must wire it — `tools/list` in the wrong path will silently miss your tools.

---

## Verification gate (every PR clears this)

Run these from the repo root before opening a PR. The reviewer will rerun them; saving them a round-trip helps.

```bash
# 1. Compile
yarn run build
# expected: exit 0

# 2. Lint + format check
yarn run check
# expected: exit 0, 24 baseline warnings (all in src/vnc/protocol/ — pre-existing,
# not yours to fix in a feature PR)
yarn run check:write   # auto-fixes Biome-fixable issues; rerun `check` after

# 3. Type-safety grep — must return zero matches
grep -rE ":\s*any\b|@ts-ignore|as\s+any" src/

# 4. Log-discipline grep — must return zero matches
grep -rE "console\.log" src/

# 5. Tool listing smoke — must include your new tool in the count
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | MCP_TRANSPORT=stdio THREATZONE_ALLOW_SUBMIT=true node dist/index.js 2>/dev/null \
  | grep -o '"name":"[a-z0-9_]*"' | sort -u | wc -l

# 6. HTTP boot smoke — must return 200
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=7861 node dist/index.js &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7861/healthz
kill $SERVER_PID
```

For tools that hit live endpoints, also do a one-shot live call (token required):

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tz_your_new_tool","arguments":{"uuid":"…"}}}\n' \
  | MCP_TRANSPORT=stdio THREATZONE_API_TOKEN=$TZ_TOKEN \
    THREATZONE_API_BASE_URL=https://staging.threat.zone/public-api \
    node dist/index.js 2>/dev/null
```

There is no automated test suite yet — `yarn test` runs Jest with `--passWithNoTests`. If you add tests (welcome but not required), `package.json` will need `jest` added to `devDependencies`.

---

## Common workflows

### Adding a new env var

1. Add a getter to `src/api/config.ts` (or the appropriate domain config) — never read `process.env.X` from a tool handler directly.
2. Document the default + purpose in the env-var table in `CLAUDE.md` (architecture-level doc).
3. Add a row to the env-var table in `README.md` "Configuration" section.
4. Add the var to `.env.example` with a comment explaining when to set it.
5. If the var gates a feature (like `THREATZONE_ALLOW_SUBMIT`), use **strict equality** (`=== 'true'`), not truthy coercion. Test with `=1`, `=TRUE`, `=yes` to confirm only literal `'true'` enables.

### Adding a new error code (API domain)

1. Append the code to the `ApiErrorCode` union in (upstream) `apps/public-api-service/src/common/responses/error.response.ts`.
2. Use it in the throw site: `throw new ApiException(404, 'YOUR_NEW_CODE', 'message', details)`.
3. The MCP side (`src/api/errors.ts`) doesn't need a new subclass — `ApiError` carries the code, and `apiErrorResult` formats `Error [<code>]: <message>` for any code. Only add a subclass if you want type-narrowing in MCP-side code.
4. Update Swagger annotations on the controller (`@ApiNotFoundResponse({ description: '…' })`) and any `## Errors` table in the description string.

### Debugging an upstream API call

The `apiRequest` client preserves the upstream error envelope into typed errors. If a tool returns `Error [UNKNOWN_ERROR]: …` in stdio output, the upstream response was either non-JSON or missing the canonical `{ statusCode, message, code }` envelope. Read the upstream service's error-handler code, not the MCP — the MCP is forwarding correctly.

For deployment-lag 404s (route exists in source but production returns `Cannot GET /path`), the MCP now emits `Error [ROUTE_NOT_IMPLEMENTED]: Endpoint not implemented at this URL …`. The fix is to deploy the latest upstream service, not to change the MCP.

### Debugging the VNC keymap

The `type_text` handler in `src/vnc/tools/type-text.ts` brackets a fixed regex of shifted ASCII chars (`[A-Z!$%^&*()_+{}:<>?]`) with `Shift_L` press/release. Five chars (`~ | " @ #`) are deliberately excluded because they sit on different physical keys between US and UK ANSI layouts and bracketing causes mis-translations. If you find a new char that arrives wrong, first determine whether it's a Shift-issue (US/UK layout-stable, fixable by adding to the regex) or a layout-mismatch (US/UK swap, unfixable client-side without knowing the VM's keymap — same bucket as the excluded five).

For arbitrary text containing many tricky chars, use `clipboard_write` + paste (`send_key('v', modifiers=['super'])`). Clipboard sync requires Extended Clipboard encoding (`-260`) which is registered automatically — verify by checking `serverSupportsExtClipboard` becomes true after the first server-cut-text negotiation message.

### Re-running the local server after edits

```bash
# from another terminal (the build is fast — ~1.5s)
yarn run build && pkill -f 'dist/index.js'
# then restart in your original terminal
yarn run start
```

If you're iterating heavily, `yarn run start:dev` runs from source via `ts-node` — no build step, but no watch either; restart manually.

---

## Code style

Biome (`biome.json`) is the source of truth. Key choices:

- **Indent**: tabs (visual width 2)
- **Quotes**: single in JS/TS, double in JSX (no JSX in this repo though)
- **Line width**: 100
- **Trailing commas**: always
- **Semicolons**: always
- **Imports**: organized via Biome's `assist.actions.organizeImports`. Don't manually reorder.

Run `yarn run check:write` to auto-fix anything Biome-fixable. The 24 pre-existing warnings in `src/vnc/protocol/` (non-null assertions, unused vars in legacy code) are baseline — don't fix them as part of an unrelated PR; that's churn.

Naming:

- **Files**: kebab-case (`type-text.ts`, `submission-browse.ts`)
- **Functions/handlers**: `handle<ToolName>` (camelCase)
- **MCP tool names**: API tools `tz_<group>_<resource>` (snake_case), VNC tools unprefixed (legacy)
- **Classes/types/interfaces**: PascalCase
- **Constants**: SCREAMING_SNAKE_CASE for module-level immutables

---

## Git / PR conventions

- **Branch naming**: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`. The repo's CI checks the prefix.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`). Each commit should pass `yarn run build` and `yarn run check`.
- **PRs**: keep the diff focused on one domain. If you find an unrelated bug, file a separate issue and PR. Reviewers will reject grab-bag PRs.
- **Don't commit `.env`** — only `.env.example`.
- **Don't commit `dist/`** — it's gitignored and built fresh in CI.

---

## When in doubt

1. Read the equivalent existing tool file. Most patterns are 30-50 lines and self-explanatory once you see one.
2. Read `CLAUDE.md` — it's the architecture-level spec written for AI assistants but useful for humans too.
3. Read the OpenAPI spec at `<base-url>/docs-json` for any API endpoint you're wrapping. The schema is the contract; tool descriptions can paraphrase but must not contradict.
4. Check the existing reviewer findings in recent PR history — the loop-reviewer agent rejects schema drift and missing forward-references reliably; learning from those rejections saves cycle time.

For architectural changes (new domain, transport changes, schema rework spanning many tools), discuss in an issue first. For typical "wrap a new endpoint" or "add a new VNC modifier" work, just open a PR.
