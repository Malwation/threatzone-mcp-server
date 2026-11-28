import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolError } from '../shared/errors.js';

export class VncError extends McpToolError {
	constructor(message: string, code: string) {
		super(message, code);
		this.name = 'VncError';
	}
}

export class ConnectionError extends VncError {
	constructor(message: string) {
		super(message, 'CONNECTION_ERROR');
		this.name = 'ConnectionError';
	}
}

export class AuthenticationError extends VncError {
	constructor(message: string) {
		super(message, 'AUTHENTICATION_ERROR');
		this.name = 'AuthenticationError';
	}
}

export class SessionNotFoundError extends VncError {
	constructor(sessionId?: string, message?: string) {
		super(
			message ??
				(sessionId
					? `VNC session '${sessionId}' not found`
					: 'No active VNC session. Call "connect" first.'),
			'SESSION_NOT_FOUND',
		);
		this.name = 'SessionNotFoundError';
	}
}

/** A closed session could not dial its live-view link again. `detail` must hold no token. */
export class LiveViewEndedError extends VncError {
	constructor(detail: string, fromSubmission: boolean) {
		const next = fromSubmission
			? 'If the run is still in progress, call "connect" with submission_uuid to open a new session.'
			: 'Call "connect" again to open a new session.';
		super(
			`The live view of this session ended (the run finished or the VM stopped): ${detail}. ${next}`,
			'LIVE_VIEW_ENDED',
		);
		this.name = 'LiveViewEndedError';
	}
}

export class TimeoutError extends VncError {
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms`, 'TIMEOUT');
		this.name = 'TimeoutError';
	}
}

export class UnsupportedTransportError extends VncError {
	constructor(transport: string) {
		super(
			`Transport '${transport}' is not supported by this MCP server (yet)`,
			'UNSUPPORTED_TRANSPORT',
		);
		this.name = 'UnsupportedTransportError';
	}
}

export function errorResult(err: unknown): CallToolResult {
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
