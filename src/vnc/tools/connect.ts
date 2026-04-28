import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RtcClient } from '../../rtc/protocol/rtc-client.js';
import type { SessionManager } from '../protocol/session-manager.js';
import { buildVncWsUrl, fetchTokenType, normalizeConnectInput } from '../protocol/token-info.js';

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
		const normalized = normalizeConnectInput(args.url);

		if (normalized.kind === 'websockify') {
			// Pre-resolved by the normalizer (UUID / submission URL / ws:// upgrade /
			// passthrough wss). Skip the /api/token-info probe and connect directly.
			const parsed = new URL(normalized.wsUrl);
			return await connectVncFlow(
				sessionManager,
				args,
				parsed.hostname,
				Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80),
				normalized.wsUrl,
			);
		}

		// kind === 'cloudvnc' — legacy http(s)://host/cloudvnc?token=… form.
		// Probe /api/token-info to pick VNC websockify vs WebRTC signaling.
		const { origin, token } = normalized;
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
				text: 'Error: provide "url" (submission UUID, https://app.threat.zone/submission/<UUID>, https://app.threat.zone/cloudvnc?token=<UUID>, or wss://...) or "ws_url" (raw websockify URL).',
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
