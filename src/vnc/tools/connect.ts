import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { apiRequest } from '../../api/client.js';
import { apiErrorResult, ConflictError } from '../../api/errors.js';
import { ConnectionError } from '../errors.js';
import type { SessionManager } from '../protocol/session-manager.js';
import type { VncClient } from '../protocol/vnc-client.js';

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

/** Removes the query and fragment so a live-view token never reaches tool output. */
function redactUrl(raw: string): string {
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return '<invalid URL>';
	}
}

export async function handleConnect(
	args: ConnectArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const given = [args.submission_uuid, args.url, args.ws_url].filter((v) => v !== undefined);
	if (given.length > 1) {
		return errorText('provide only one of "submission_uuid", "url" or "ws_url".');
	}

	if (args.submission_uuid !== undefined) {
		return await connectSubmission(args, args.submission_uuid, sessionManager);
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
		return await connectVncFlow(sessionManager, args, trimmed);
	}

	if (args.ws_url !== undefined) {
		return await connectVncFlow(sessionManager, args, args.ws_url);
	}

	return errorText(
		'provide "submission_uuid" (sandbox submission UUID), "url" (ws:// or wss:// URL) or "ws_url" (raw websockify URL).',
	);
}

async function connectSubmission(
	args: ConnectArgs,
	uuid: string,
	sessionManager: SessionManager,
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

	const result = await connectVncFlow(sessionManager, args, session.link);
	if (session.expiresAt !== null && !result.isError) {
		result.content.push({
			type: 'text',
			text: `Live view expires at ${new Date(session.expiresAt).toISOString()}.`,
		});
	}
	return result;
}

async function connectVncFlow(
	sessionManager: SessionManager,
	args: ConnectArgs,
	wsUrl: string,
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
	const wsHeaders = args.ws_cookie ? { Cookie: args.ws_cookie } : undefined;

	let client: VncClient;
	try {
		client = await sessionManager.connectVnc({
			host,
			port,
			wsUrl,
			wsHeaders,
			sessionId: args.session_id,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const token = parsed.searchParams.get('token');
		let safe = message.split(wsUrl).join(target);
		if (token) safe = safe.split(token).join('<redacted>');
		throw new ConnectionError(`Failed to connect to ${target}: ${safe}`);
	}

	const size = client.screenSize;
	return {
		content: [
			{
				type: 'text',
				text: `Connected to VNC session '${client.config.sessionId}' at ${target}. Screen size: ${size?.width}x${size?.height}`,
			},
		],
	};
}
