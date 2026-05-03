# Contributing to threatzone-mcp-server

Thanks for taking the time to contribute. This guide covers the practical things you need to know to ship a change: local setup, the rules every PR must follow, the most common change patterns, and the verification gate.

For deeper architecture context (session model, transport quirks, the reasoning behind some design choices), read `CLAUDE.md` — that file is the canonical spec; this file is the contributor-facing summary.

---

## Quick start

### 1. Clone, install, build

```bash
git clone <repo-url>
cd threatzone-mcp-server
yarn install
yarn run build
```

Required tooling on PATH: **Node 20+**, **yarn 1.x**. `ffmpeg` + `ffprobe` are only needed if you'll touch the RTC/Android transport.

### 2. Configure

```bash
cp .env.example .env
# edit .env — set THREATZONE_API_TOKEN if you'll exercise the tz_* API tools
```

`THREATZONE_API_TOKEN` has no default — issue one from your workspace's API keys page in the Threat.Zone UI.

### 3. Run locally

```bash
yarn run start            # uses dist/, requires a build first
yarn run start:dev        # runs from source via ts-node (no watch — restart manually)
```

The HTTP server listens on `http://127.0.0.1:7860/mcp` (Streamable HTTP) plus `/healthz`. Smoke-check:

```bash
curl -s http://127.0.0.1:7860/healthz   # → 200 OK
```

### 4. Register the local server with Claude Code

```bash
claude mcp add threatzone-local --transport http http://127.0.0.1:7860/mcp
```

For Claude Desktop, see the README — the desktop config uses stdio transport.

---

## The five hard rules

Non-negotiable. Reviewers will block your PR on any of these.

### 1. `console.error()` only — never `console.log()`

In stdio mode **stdout is the MCP wire**. Any `console.log()` corrupts the JSON-RPC stream and breaks every connected client. Use `console.error()` for every debug line, including in HTTP mode (consistency, plus the server can be flipped to stdio at any time).

```ts
console.error('[vnc] connecting to', url);   // ✓
console.log('connecting to', url);            // ✗ breaks stdio clients
```

The `[domain]` prefix is conventional, not enforced.

### 2. ESM `.js` extension on every relative import

Module resolution is `Node16` / `NodeNext`. Source imports must end in `.js` — the resolver finds the `.ts` file, but the spec requires the `.js` extension at runtime.

```ts
import { apiRequest } from '../client.js';        // ✓
import { apiRequest } from '../client';           // ✗ ERR_MODULE_NOT_FOUND
```

Biome doesn't catch this — it's on you.

### 3. No `any`, no `@ts-ignore`, no `as any`

Use `unknown` and narrow with type guards or `instanceof`. The `skipLibCheck: true` flag is load-bearing for `rfb2` and `@roamhq/wrtc` only — don't take it as license to weaken types in your own code.

```bash
# Verification — must return zero matches
grep -rE ":\s*any\b|@ts-ignore|as\s+any" src/
```

### 4. Don't touch unrelated domains

`src/vnc/`, `src/rtc/`, `src/shared/`, and `src/api/` are independent. A PR adding a new API tool should not modify VNC files. If you find a bug in another domain, file a separate issue and PR — don't bundle.

The only file that legitimately gets touched across domains is `src/index.ts`, and only when wiring a brand new domain.

### 5. The Authorization header value never appears in logs or thrown errors

`api/client.ts` builds the `Bearer <token>` header inside the `headers` dict. Don't log the headers object, don't include the token in error messages, don't print it in debug output. This is a leakage class — keep it watertight.

---

## How to add a new feature

Pick the section that matches what you're building. The pattern is short — read one existing tool file in the domain you're touching before writing anything.

### Adding a new API tool (most common)

You're wrapping a new Public API endpoint as a `tz_*` tool.

1. **Confirm the endpoint exists in the OpenAPI spec.** Pull `<base-url>/docs-json` and read parameters, responses, and any `$ref` schemas you'll surface in the tool description.
2. **Pick the right `src/api/tools/<group>.ts` file** (account, config, submission-browse, submission-analysis, submission-network, downloads, submit). Append to the existing file unless your endpoint is its own logical group.
3. **Add the tool** following the pattern below.
4. **Wire it up** if you created a new file — append to `src/api/register.ts`.
5. **Document it** — add a row to the appropriate table in `README.md` "Tools" section.
6. **Run the verification gate** (see below).

```ts
server.tool(
  'tz_submission_threat_actors',
  'Returns threat actor mappings observed during analysis. Empty array if none.',
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

Conventions:

- **Name**: `tz_<domain>_<resource>` snake_case. Pick the prefix that places the tool in a discoverable group in the README.
- **`api_token`**: every tool accepts it (per-call override of `THREATZONE_API_TOKEN`).
- **`uuid`**: don't add `.uuid()` or `.regex()` — the API returns `INVALID_UUID` with a useful message; client-side validation duplicates work.
- **`page`/`limit`**: only if the OpenAPI says so. Match the API's actual constraints.
- **`limit`/`skip`**: only used by `tz_network_*` tools. Note in the description: `Uses limit/skip offset pagination — NOT page/limit`.
- **Return value**: `JSON.stringify(data, null, 2)` verbatim. Don't transform the response.
- **Error handling**: every handler is wrapped in `try { ... } catch (err) { return apiErrorResult(err); }`. The typed error subclasses do the right thing.
- **No auto-pagination, no auto-polling.** Submit tools return UUID + message; the LLM polls via `tz_submission_get`.

### Adding a binary download tool

Use the shared `handleBinaryDownload` helper from `src/api/tools/downloads.ts`:

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

The helper enforces the 25 MB inline cap, handles the `save_to` disk-write branch, and parses `Content-Disposition` for the filename.

### Adding a write-surface tool (POST)

Submit tools live in `src/api/tools/submit.ts`. Add new `server.tool(...)` calls inside `registerSubmitTools`.

For multipart bodies build a `FormData`, append `file` first, then string fields. Don't set `Content-Type` manually — `apiRequest` detects `body instanceof FormData` and lets `fetch` set the multipart boundary. JSON bodies: pass a plain object; `apiRequest` JSON-stringifies and sets `Content-Type: application/json`.

### Adding a new VNC tool

Pattern in `src/vnc/tools/<tool-name>.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface NewToolArgs {
  session_id?: string;
}

export async function handleNewTool(
  args: NewToolArgs,
  sessionManager: SessionManager,
): Promise<CallToolResult> {
  const client = sessionManager.getSession(args.session_id);
  return { content: [{ type: 'text', text: 'OK' }] };
}
```

Register in `src/vnc/register.ts` with `server.tool(name, description, zodSchema, handler)`. If the tool is RTC-only, implement on `RtcClient` only and have `VncClient` throw `UnsupportedOnTransportError`. Tool handlers consume sessions via the shared `RemoteSession` interface — don't branch on transport.

VNC tool names are **unprefixed** (legacy). The `tz_` prefix is reserved for the API domain.

### Adding a new env var

1. Add a getter to `src/api/config.ts` (or the appropriate domain config). Never read `process.env.X` directly from a tool handler.
2. Add a row to the env-var table in `README.md`.
3. Add the var to `.env.example` with a comment explaining when to set it.
4. If the var gates a feature, use **strict equality** (`=== 'true'`) — not truthy coercion.

---

## Verification gate

Run these before opening a PR. The reviewer will rerun them.

```bash
# 1. Compile
yarn run build

# 2. Lint + format check
yarn run check
yarn run check:write   # auto-fixes Biome-fixable issues; rerun `check` after

# 3. Type-safety grep — must return zero matches
grep -rE ":\s*any\b|@ts-ignore|as\s+any" src/

# 4. Log-discipline grep — must return zero matches
grep -rE "console\.log" src/

# 5. Tool listing smoke — your new tool must appear
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | MCP_TRANSPORT=stdio node dist/index.js 2>/dev/null \
  | grep -o '"name":"[a-z0-9_]*"' | sort -u

# 6. HTTP boot smoke
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=7861 node dist/index.js &
SERVER_PID=$!
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7861/healthz
kill $SERVER_PID
```

For tools that hit live endpoints, also do a one-shot live call against staging (token required):

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tz_your_new_tool","arguments":{"uuid":"..."}}}\n' \
  | MCP_TRANSPORT=stdio THREATZONE_API_TOKEN=$TZ_TOKEN \
    THREATZONE_API_BASE_URL=https://staging.threat.zone/public-api \
    node dist/index.js 2>/dev/null
```

There is no automated test suite yet — `yarn test` runs Jest with `--passWithNoTests`. Tests are welcome but not required.

---

## Code style

Biome (`biome.json`) is the source of truth. Key choices:

- **Indent**: tabs (visual width 2)
- **Quotes**: single in JS/TS
- **Line width**: 100
- **Trailing commas**: always
- **Semicolons**: always
- **Imports**: organized via Biome's `assist.actions.organizeImports` — don't manually reorder

Run `yarn run check:write` to auto-fix anything Biome-fixable. The 24 pre-existing warnings in `src/vnc/protocol/` are baseline — don't fix them as part of an unrelated PR; that's churn.

Naming:

- **Files**: kebab-case (`type-text.ts`, `submission-browse.ts`)
- **Functions/handlers**: `handle<ToolName>` (camelCase)
- **MCP tool names**: API tools `tz_<group>_<resource>` (snake_case); VNC tools unprefixed (legacy)
- **Classes/types/interfaces**: PascalCase
- **Constants**: SCREAMING_SNAKE_CASE for module-level immutables

---

## Git / PR conventions

- **Branch naming**: `feat/<short-name>`, `fix/<short-name>`, `chore/<short-name>`. CI checks the prefix.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`). Each commit should pass `yarn run build` and `yarn run check`.
- **PRs**: focused on one domain. Unrelated bugs go in separate PRs.
- **Don't commit `.env`** — only `.env.example`.
- **Don't commit `dist/`** — gitignored, built fresh in CI.

---

## When in doubt

1. Read the equivalent existing tool file. Most patterns are 30–50 lines and self-explanatory.
2. Read `CLAUDE.md` — architecture-level spec.
3. Read the OpenAPI spec at `<base-url>/docs-json` for any API endpoint you're wrapping. The schema is the contract; tool descriptions can paraphrase but must not contradict.

For architectural changes (new domain, transport changes, schema rework spanning many tools), discuss in an issue first. For typical "wrap a new endpoint" or "add a new VNC modifier" work, just open a PR.
