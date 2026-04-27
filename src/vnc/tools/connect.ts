import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RtcClient } from '../../rtc/protocol/rtc-client.js';
import type { SessionManager } from '../protocol/session-manager.js';
import { buildVncWsUrl, fetchTokenType, parseTokenUrl } from '../protocol/token-info.js';

export interface ConnectArgs {
	url?: string;
	ws_url?: string;
	ws_cookie?: string;
	session_id?: string;
}

export async function handleConnect(
	args: ConnectArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	if (args.url) {
		// Token-URL mode: probe /api/token-info first, then route to whichever
		// transport the gateway advertises. Mirrors apps/novnc/vnc/www/app/ui.js.
		const { origin, token } = parseTokenUrl(args.url);
		const type = await fetchTokenType(origin, token);

		if (type === 'webrtc') {
			const signalingUrl = `${origin
				.replace(/^https/i, 'wss')
				.replace(/^http/i, 'ws')}/webrtc-signal?token=${encodeURIComponent(token)}`;
			const parsedOrigin = new URL(origin);
			const sessionId = args.session_id ?? randomUUID();
			const client = new RtcClient({
				signalingUrl,
				sessionId,
				host: parsedOrigin.hostname,
				port: Number(parsedOrigin.port) || (parsedOrigin.protocol === 'https:' ? 443 : 80),
			});
			await client.connect();
			sessionManager.register(client);
			const size = client.screenSize;
			return {
				content: [
					{
						type: 'text',
						text: `Connected to RTC session '${sessionId}' at ${origin} (Android device). Screen size: ${size?.width}x${size?.height}`,
					},
				],
			};
		}

		// type === 'vnc' — route through websockify (same as the browser).
		const wsUrl = buildVncWsUrl(origin, token);
		const parsed = new URL(wsUrl);
		return await connectVncFlow(
			sessionManager,
			args,
			parsed.hostname,
			Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80),
			wsUrl,
		);
	}

	if (args.ws_url) {
		// Raw websockify URL — host/port are just labels for the session.
		const parsed = new URL(args.ws_url);
		const host = parsed.hostname;
		const port = Number(parsed.port) || 443;
		return await connectVncFlow(sessionManager, args, host, port, args.ws_url);
	}

	return {
		content: [
			{
				type: 'text',
				text: 'Error: provide "url" (cloudvnc link, e.g. https://app.threat.zone/cloudvnc?token=...) or "ws_url" (raw websockify URL).',
			},
		],
		isError: true,
	};
}

async function connectVncFlow(
	sessionManager: SessionManager,
	args: ConnectArgs,
	host: string,
	port: number,
	wsUrl?: string,
): Promise<CallToolResult> {
	const wsHeaders = args.ws_cookie ? { Cookie: args.ws_cookie } : undefined;

	const client = await sessionManager.connectVnc({
		host,
		port,
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
