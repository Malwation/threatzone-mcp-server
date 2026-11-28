import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { getApiBaseUrl } from './api/config.js';
import { registerApiTools } from './api/register.js';
import type { ToolContext } from './shared/tool-context.js';
import type { SessionManager } from './vnc/protocol/session-manager.js';
import { registerVncTools } from './vnc/register.js';

export interface HttpAppOptions {
	serverVersion: string;
	toolContext: ToolContext;
	/** Shared by every MCP session of this process. */
	sessionManager: SessionManager;
}

/** Express app with `/mcp` (one McpServer + transport per MCP session) and `/healthz`. */
export function createHttpApp(opts: HttpAppOptions): express.Express {
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
			const server = new McpServer({ name: 'threatzone-mcp', version: opts.serverVersion });
			registerVncTools(server, opts.toolContext, opts.sessionManager);
			registerApiTools(server, opts.toolContext);
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

	return app;
}
