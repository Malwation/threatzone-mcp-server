import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';
import type { TokenResolver } from '../redis/token-resolver.js';

export interface ConnectArgs {
	token?: string;
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	ws_url?: string;
	ws_cookie?: string;
	session_id?: string;
}

export async function handleConnect(
	args: ConnectArgs,
	sessionManager: SessionManager,
	tokenResolver: TokenResolver | null,
): Promise<CallToolResult> {
	let host: string;
	let port: number;
	let wsUrl: string | undefined;

	if (args.ws_url) {
		// WebSocket connection — host/port are just labels for the session
		wsUrl = args.ws_url;
		host = new URL(args.ws_url).hostname;
		port = Number(new URL(args.ws_url).port) || 443;
	} else if (args.token) {
		if (!tokenResolver) {
			return {
				content: [
					{ type: 'text', text: 'Error: Token resolution requires REDIS_URL environment variable' },
				],
				isError: true,
			};
		}
		const target = await tokenResolver.resolve(args.token);
		host = target.host;
		port = target.port;
	} else if (args.host) {
		host = args.host;
		port = args.port ?? (Number(process.env.VNC_DEFAULT_PORT) || 5901);
	} else {
		return {
			content: [
				{ type: 'text', text: 'Error: Either "ws_url", "token", or "host" must be provided' },
			],
			isError: true,
		};
	}

	const wsHeaders = args.ws_cookie ? { Cookie: args.ws_cookie } : undefined;

	const client = await sessionManager.connect({
		host,
		port,
		username: args.username,
		password: args.password,
		wsUrl,
		wsHeaders,
		sessionId: args.session_id,
	});

	const size = client.screenSize;
	const target = wsUrl ? wsUrl : `${host}:${port}`;
	return {
		content: [
			{
				type: 'text',
				text: `Connected to VNC session '${client.config.sessionId}' at ${target}. Screen size: ${size?.width}x${size?.height}`,
			},
		],
	};
}
