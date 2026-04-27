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
	constructor(sessionId?: string) {
		super(
			sessionId
				? `VNC session '${sessionId}' not found`
				: 'No active VNC session. Call "connect" first.',
			'SESSION_NOT_FOUND',
		);
		this.name = 'SessionNotFoundError';
	}
}

export class TimeoutError extends VncError {
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms`, 'TIMEOUT');
		this.name = 'TimeoutError';
	}
}

export class TokenResolutionError extends VncError {
	constructor(token: string, reason: string) {
		super(`Failed to resolve token '${token}': ${reason}`, 'TOKEN_RESOLUTION_ERROR');
		this.name = 'TokenResolutionError';
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
