import { Buffer } from 'node:buffer';
import { getApiBaseUrl, getApiToken } from './config.js';
import {
	ApiError,
	BadRequestError,
	ConflictError,
	ForbiddenError,
	InternalApiError,
	NotFoundError,
	RateLimitError,
	UnauthorizedError,
	UnprocessableError,
} from './errors.js';

export interface ApiRequestOptions {
	path: string;
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
	query?: Record<string, string | number | boolean | string[] | undefined>;
	body?: unknown;
	binary?: boolean;
	signal?: AbortSignal;
	apiToken?: string;
}

export interface BinaryResponse {
	buffer: Buffer;
	contentType: string;
	contentDisposition: string | undefined;
}

// Maps HTTP status code to the appropriate typed error subclass.
function mapStatusToError(
	status: number,
	message: string,
	code: string,
	details?: unknown,
): ApiError {
	switch (status) {
		case 400:
			return new BadRequestError(message, code);
		case 401:
			return new UnauthorizedError(message);
		case 403:
			return new ForbiddenError(message, code);
		case 404:
			return new NotFoundError(message, code);
		case 409:
			return new ConflictError(message, code, details);
		case 422:
			return new UnprocessableError(message);
		case 429:
			return new RateLimitError(message, code);
		default:
			if (status >= 500) {
				return new InternalApiError(message);
			}
			return new ApiError(message, code, status, details);
	}
}

// Attempts to parse an error response body as the canonical error envelope.
// Returns a typed ApiError on success, or null if the body is not valid JSON envelope.
async function parseErrorResponse(res: Response): Promise<ApiError | null> {
	const rawText = await res.text().catch(() => '');
	try {
		const parsed: unknown = JSON.parse(rawText);
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'message' in parsed &&
			'statusCode' in parsed
		) {
			const envelope = parsed as {
				statusCode: number;
				message: string;
				code?: string;
				details?: unknown;
			};
			const code = typeof envelope.code === 'string' ? envelope.code : 'UNKNOWN_ERROR';
			return mapStatusToError(res.status, envelope.message, code, envelope.details);
		}
	} catch {
		// JSON parse failed — fall through to raw text error
	}
	return new ApiError(rawText || `HTTP ${res.status}`, 'UNKNOWN_ERROR', res.status);
}

export async function apiRequest(
	opts: ApiRequestOptions & { binary: true },
): Promise<BinaryResponse>;
export async function apiRequest(opts: ApiRequestOptions): Promise<unknown>;
export async function apiRequest(opts: ApiRequestOptions): Promise<unknown | BinaryResponse> {
	const token = getApiToken(opts.apiToken);
	if (!token) {
		throw new UnauthorizedError('THREATZONE_API_TOKEN env var or apiToken arg is required');
	}

	const baseUrl = getApiBaseUrl();
	const url = new URL(`${baseUrl}${opts.path}`);

	// Append query parameters — skip undefined values; repeat key for string arrays.
	if (opts.query) {
		for (const [key, value] of Object.entries(opts.query)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) {
				for (const item of value) {
					url.searchParams.append(key, item);
				}
			} else {
				url.searchParams.append(key, String(value));
			}
		}
	}

	const headers: Record<string, string> = {
		// Token value must NOT appear in logs — do not log this header object.
		Authorization: `Bearer ${token}`,
	};

	let fetchBody: FormData | string | undefined;
	if (opts.body instanceof FormData) {
		// Do NOT set Content-Type — fetch sets the multipart boundary automatically.
		fetchBody = opts.body;
	} else if (opts.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		fetchBody = JSON.stringify(opts.body);
	}

	const res = await fetch(url.toString(), {
		method: opts.method ?? 'GET',
		headers,
		body: fetchBody,
		signal: opts.signal,
	});

	if (opts.binary === true) {
		if (!res.ok) {
			const apiErr = await parseErrorResponse(res);
			throw apiErr;
		}
		const arrayBuffer = await res.arrayBuffer();
		return {
			buffer: Buffer.from(arrayBuffer),
			contentType: res.headers.get('content-type') ?? 'application/octet-stream',
			contentDisposition: res.headers.get('content-disposition') ?? undefined,
		} satisfies BinaryResponse;
	}

	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		if (!res.ok) {
			throw new ApiError(text || `HTTP ${res.status}`, 'UNKNOWN_ERROR', res.status);
		}
		// Successful non-JSON response — return raw text as string.
		return text;
	}

	if (res.ok) {
		return parsed;
	}

	// Error response with parseable JSON envelope.
	if (
		parsed !== null &&
		typeof parsed === 'object' &&
		'message' in parsed &&
		'statusCode' in parsed
	) {
		const envelope = parsed as {
			statusCode: number;
			message: string;
			code?: string;
			details?: unknown;
		};
		const code = typeof envelope.code === 'string' ? envelope.code : 'UNKNOWN_ERROR';
		throw mapStatusToError(res.status, envelope.message, code, envelope.details);
	}

	throw new ApiError(text || `HTTP ${res.status}`, 'UNKNOWN_ERROR', res.status);
}
