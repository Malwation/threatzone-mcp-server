import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logEffectiveConfig } from './api/config.js';
import { registerApiTools } from './api/register.js';
import { createHttpApp } from './http-app.js';
import { parseTransportMode, type ToolContext } from './shared/tool-context.js';
import { SessionManager } from './vnc/protocol/session-manager.js';
import { registerVncTools } from './vnc/register.js';

const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json');
const parsedPackageJson: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
if (
	typeof parsedPackageJson !== 'object' ||
	parsedPackageJson === null ||
	!('version' in parsedPackageJson) ||
	typeof (parsedPackageJson as { version: unknown }).version !== 'string'
) {
	throw new Error(`Invalid package.json at ${PACKAGE_JSON_PATH}: missing string "version"`);
}
const SERVER_VERSION = (parsedPackageJson as { version: string }).version;

const transportMode = parseTransportMode(process.env.MCP_TRANSPORT);
const toolContext: ToolContext = { transportMode };
// One manager per process: HTTP MCP sessions share it, and session IDs keep them apart.
const sessionManager = SessionManager.forTransport(transportMode);

async function startStdio(): Promise<void> {
	logEffectiveConfig();
	const server = new McpServer({ name: 'threatzone-mcp', version: SERVER_VERSION });
	registerVncTools(server, toolContext, sessionManager);
	registerApiTools(server, toolContext);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

async function startHttp(): Promise<void> {
	logEffectiveConfig();

	const port = Number(process.env.MCP_HTTP_PORT ?? 7860);
	const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';

	const app = createHttpApp({ serverVersion: SERVER_VERSION, toolContext, sessionManager });

	await new Promise<void>((resolve) => {
		app.listen(port, host, () => {
			console.error(`[mcp] listening on http://${host}:${port}/mcp`);
			resolve();
		});
	});
}

process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
	console.error('Unhandled rejection:', err);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.once(signal, () => {
		console.error(`[mcp] ${signal}: closing VNC sessions`);
		sessionManager.disconnectAll();
		process.exit(0);
	});
}

const main = transportMode === 'stdio' ? startStdio : startHttp;

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
