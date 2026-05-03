import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { getApiBaseUrl, logEffectiveConfig } from './api/config.js';
import { registerApiTools } from './api/register.js';
import { registerVncTools } from './vnc/register.js';

const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json');
const { version: SERVER_VERSION } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
	version: string;
};

const transportMode = (process.env.MCP_TRANSPORT ?? 'http').toLowerCase();

async function startStdio(): Promise<void> {
	logEffectiveConfig();
	const server = new McpServer({ name: 'threatzone-mcp', version: SERVER_VERSION });
	registerVncTools(server);
	registerApiTools(server);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

async function startHttp(): Promise<void> {
	logEffectiveConfig();

	const port = Number(process.env.MCP_HTTP_PORT ?? 7860);
	const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';

	const app = express();
	app.use(express.json({ limit: '50mb' }));

	const transports = new Map<string, StreamableHTTPServerTransport>();

	app.get('/healthz', (_req, res) => {
		res.status(200).json({ status: 'ok', apiBase: getApiBaseUrl() });
	});

	app.all('/mcp', async (req, res) => {
		const sid = req.headers['mcp-session-id'];
		const sessionId = typeof sid === 'string' ? sid : undefined;

		let transport = sessionId ? transports.get(sessionId) : undefined;

		if (!transport && req.method === 'POST' && isInitializeRequest(req.body)) {
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (id) => {
					if (transport) transports.set(id, transport);
				},
			});
			transport.onclose = () => {
				if (transport?.sessionId) transports.delete(transport.sessionId);
			};
			const server = new McpServer({ name: 'threatzone-mcp', version: SERVER_VERSION });
			registerVncTools(server);
			registerApiTools(server);
			await server.connect(transport);
		} else if (!transport) {
			res.status(400).json({
				jsonrpc: '2.0',
				error: { code: -32000, message: 'Bad Request: no valid session ID' },
				id: null,
			});
			return;
		}

		await transport.handleRequest(req, res, req.body);
	});

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

const main = transportMode === 'stdio' ? startStdio : startHttp;

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
