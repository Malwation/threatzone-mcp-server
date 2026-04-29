import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolError } from '../shared/errors.js';

// Base for all Public API errors — preserves the machine-readable code
// so LLM clients can branch on e.g. SUBMISSION_NOT_FOUND vs RATE_LIMIT_EXCEEDED.
export class ApiError extends McpToolError {
	readonly statusCode: number;
	readonly details?: unknown;

	constructor(message: string, code: string, statusCode: number, details?: unknown) {
		super(message, code);
		this.name = 'ApiError';
		this.statusCode = statusCode;
		this.details = details;
	}
}

// HTTP 401
export class UnauthorizedError extends ApiError {
	constructor(message: string) {
		super(message, 'UNAUTHORIZED', 401);
		this.name = 'UnauthorizedError';
	}
}

// HTTP 403 — SUBMISSION_PRIVATE or module not on plan
export class ForbiddenError extends ApiError {
	constructor(message: string, code = 'FORBIDDEN') {
		super(message, code, 403);
		this.name = 'ForbiddenError';
	}
}

// HTTP 404 — SUBMISSION_NOT_FOUND, SAMPLE_NOT_AVAILABLE, ARTIFACT_NOT_FOUND, MEDIA_NOT_FOUND, etc.
export class NotFoundError extends ApiError {
	constructor(message: string, code = 'NOT_FOUND') {
		super(message, code, 404);
		this.name = 'NotFoundError';
	}
}

// HTTP 400 — INVALID_UUID, INVALID_QUERY_PARAM
export class BadRequestError extends ApiError {
	constructor(message: string, code = 'BAD_REQUEST') {
		super(message, code, 400);
		this.name = 'BadRequestError';
	}
}

// HTTP 409 — DYNAMIC_REPORT_UNAVAILABLE, URL_ANALYSIS_REPORT_UNAVAILABLE, etc.
export class ConflictError extends ApiError {
	constructor(message: string, code: string, details?: unknown) {
		super(message, code, 409, details);
		this.name = 'ConflictError';
	}
}

// HTTP 422 — validation failures on POST bodies
export class UnprocessableError extends ApiError {
	constructor(message: string) {
		super(message, 'INVALID_QUERY_PARAM', 422);
		this.name = 'UnprocessableError';
	}
}

// HTTP 429 — RATE_LIMIT_EXCEEDED, SUBMISSION_LIMIT_EXCEEDED
export class RateLimitError extends ApiError {
	constructor(message: string, code = 'RATE_LIMIT_EXCEEDED') {
		super(message, code, 429);
		this.name = 'RateLimitError';
	}
}

// HTTP 500 / generic server error
export class InternalApiError extends ApiError {
	constructor(message: string) {
		super(message, 'INTERNAL_ERROR', 500);
		this.name = 'InternalApiError';
	}
}

export function apiErrorResult(err: unknown): CallToolResult {
	if (err instanceof ApiError) {
		return {
			content: [{ type: 'text', text: `Error [${err.code}]: ${err.message}` }],
			isError: true,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
