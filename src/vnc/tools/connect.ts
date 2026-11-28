import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiRequest } from '../../api/client.js';
import { apiErrorResult, ConflictError } from '../../api/errors.js';
import type { RemoteSession } from '../../shared/remote-session.js';
import type { ToolContext } from '../../shared/tool-context.js';
import { ConnectionError } from '../errors.js';
import { redactMessage, redactUrl } from '../protocol/redact.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface ConnectArgs {
	submission_uuid?: string;
	api_token?: string;
	url?: string;
	ws_url?: string;
	ws_cookie?: string;
	session_id?: string;
}

/** Response of `GET /submissions/{uuid}/dynamic/session` (Public API). */
interface DynamicSessionResponse {
	state: 'running' | 'unavailable';
	vncAvailable: boolean;
	link: string | null;
	expiresAt: number | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMISSION_PATH_REGEX =
	/\/submission\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i;

function errorText(text: string): CallToolResult {
	return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/**
 * HTTP-mode session ID: SHA-256 (hex) of the live-view token in the link. The server derives it,
 * so the caller cannot choose it, and the raw token never appears in tool output.
 */
export function liveViewSessionId(link: string): string {
	let secret = link;
	try {
		secret = new URL(link).searchParams.get('token') || link;
	} catch {
		// connectVncFlow rejects the invalid URL with a redacted message.
	}
	return createHash('sha256').update(secret).digest('hex');
}

export async function handleConnect(
	args: ConnectArgs,
	sessionManager: SessionManager,
	ctx: ToolContext,
): Promise<CallToolResult> {
	if (ctx.transportMode === 'http') {
		if (args.submission_uuid === undefined) {
			return errorText('provide "submission_uuid" (sandbox submission UUID).');
		}
		return await connectSubmission(args, args.submission_uuid, sessionManager, ctx);
	}

	const given = [args.submission_uuid, args.url, args.ws_url].filter((v) => v !== undefined);
	if (given.length > 1) {
		return errorText('provide only one of "submission_uuid", "url" or "ws_url".');
	}

	if (args.submission_uuid !== undefined) {
		return await connectSubmission(args, args.submission_uuid, sessionManager, ctx);
	}

	if (args.url !== undefined) {
		const trimmed = args.url.trim();
		if (UUID_REGEX.test(trimmed)) {
			return errorText(
				'"url" no longer accepts a submission UUID. Pass it as "submission_uuid" instead.',
			);
		}
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return errorText(
				'"url" must be a ws:// or wss:// URL. For a submission use "submission_uuid".',
			);
		}
		if (SUBMISSION_PATH_REGEX.test(parsed.pathname)) {
			return errorText(
				'"url" no longer accepts a submission page URL. Pass the submission UUID as "submission_uuid" instead.',
			);
		}
		if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
			return errorText(
				`"url" must be a ws:// or wss:// URL (got ${parsed.protocol}//). For a submission use "submission_uuid".`,
			);
		}
		return await connectVncFlow(sessionManager, trimmed, {
			wsCookie: args.ws_cookie,
			sessionId: args.session_id,
			shared: false,
		});
	}

	if (args.ws_url !== undefined) {
		return await connectVncFlow(sessionManager, args.ws_url, {
			wsCookie: args.ws_cookie,
			sessionId: args.session_id,
			shared: false,
		});
	}

	return errorText(
		'provide "submission_uuid" (sandbox submission UUID), "url" (ws:// or wss:// URL) or "ws_url" (raw websockify URL).',
	);
}

async function connectSubmission(
	args: ConnectArgs,
	uuid: string,
	sessionManager: SessionManager,
	ctx: ToolContext,
): Promise<CallToolResult> {
	let session: DynamicSessionResponse;
	try {
		session = (await apiRequest({
			path: `/submissions/${encodeURIComponent(uuid)}/dynamic/session`,
			apiToken: args.api_token,
		})) as DynamicSessionResponse;
	} catch (err) {
		if (err instanceof ConflictError) {
			return errorText(
				`[${err.code}] submission ${uuid} is a URL analysis. The connect tool does not support URL-analysis live sessions yet (they need VNC password auth).`,
			);
		}
		return apiErrorResult(err);
	}

	if (session.state !== 'running') {
		return errorText(
			`the live view of submission ${uuid} is not running. The run has not started or has ended.`,
		);
	}
	if (!session.vncAvailable || !session.link) {
		return errorText(
			`no live-view link for submission ${uuid}. Only the submitter or a workspace admin can open this live view.`,
		);
	}

	const result =
		ctx.transportMode === 'http'
			? await connectVncFlow(sessionManager, session.link, {
					sessionId: liveViewSessionId(session.link),
					shared: true,
				})
			: await connectVncFlow(sessionManager, session.link, {
					wsCookie: args.ws_cookie,
					sessionId: args.session_id,
					shared: false,
				});
	if (session.expiresAt !== null && !result.isError) {
		result.content.push({
			type: 'text',
			text: `Live view expires at ${new Date(session.expiresAt).toISOString()}.`,
		});
	}
	return result;
}

interface DialOptions {
	wsCookie?: string;
	sessionId?: string;
	/** HTTP mode: reuse a connected session with the same ID instead of dialing again. */
	shared: boolean;
}

async function connectVncFlow(
	sessionManager: SessionManager,
	wsUrl: string,
	opts: DialOptions,
): Promise<CallToolResult> {
	let parsed: URL;
	try {
		parsed = new URL(wsUrl);
	} catch {
		throw new ConnectionError(`Invalid WebSocket URL: ${redactUrl(wsUrl)}`);
	}
	const host = parsed.hostname;
	const port = Number(parsed.port) || (parsed.protocol === 'ws:' ? 80 : 443);
	const target = redactUrl(wsUrl);
	const wsHeaders = opts.wsCookie ? { Cookie: opts.wsCookie } : undefined;

	let client: RemoteSession;
	let reused = false;
	try {
		if (opts.shared && opts.sessionId) {
			({ client, reused } = await sessionManager.connectOrReuse({
				host,
				port,
				wsUrl,
				sessionId: opts.sessionId,
			}));
		} else {
			client = await sessionManager.connectVnc({
				host,
				port,
				wsUrl,
				wsHeaders,
				sessionId: opts.sessionId,
			});
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ConnectionError(`Failed to connect to ${target}: ${redactMessage(message, wsUrl)}`);
	}

	const id = client.config.sessionId;
	const size = client.screenSize;
	const summary = reused
		? `Reusing the connected VNC session '${id}' at ${target}. Screen size: ${size?.width}x${size?.height}`
		: `Connected to VNC session '${id}' at ${target}. Screen size: ${size?.width}x${size?.height}`;
	return {
		content: [
			{
				type: 'text',
				text: opts.shared ? `${summary}. Pass this session_id to every session tool.` : summary,
			},
		],
	};
}
