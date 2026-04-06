# AGENTS.md

## Landmines

- **`rfb2` types are hand-crafted**: `src/vnc/protocol/rfb2.d.ts` was written by inspecting runtime objects — the npm package has no published types. If you upgrade `rfb2`, verify the augmented properties (`redShift`, `greenShift`, `blueShift`, `bpp`, `depth`, etc.) still exist at runtime by connecting to a test VNC server.
- **`skipLibCheck: true` is load-bearing**: Removing it breaks the build because `rfb2` has no proper type exports. Don't remove it thinking it's a shortcut.
- **Stdout is the MCP transport**: This server uses `StdioServerTransport`. Any `console.log()` corrupts the MCP protocol stream. Use `console.error()` for debug logging only.
- **Framebuffer assumes little-endian**: `src/vnc/protocol/framebuffer.ts` pixel conversion uses bit shifts without checking `isBigEndian`. Will produce garbled screenshots on big-endian VNC servers.

## Non-discoverable commands

- **Lint/format**: `yarn check` (without `run`) invokes yarn's built-in integrity check, not Biome. Always use `yarn run check` or `yarn run check:write`.
- **Dev run**: `yarn start:dev` uses `ts-node` directly (no watch mode). Restart manually after changes.

## Environment variables (not documented elsewhere)

| Variable | Used in | Default |
|---|---|---|
| `REDIS_URL` | `src/index.ts` | `null` (disables token-based connect) |
| `VNC_CONNECT_TIMEOUT` | `src/vnc/protocol/vnc-client.ts` | `10000` ms |
| `VNC_SCREENSHOT_TIMEOUT` | `src/vnc/protocol/vnc-client.ts` | `5000` ms |
| `VNC_DEFAULT_PORT` | `src/vnc/redis/token-resolver.ts` | `5901` |
