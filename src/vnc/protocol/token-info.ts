import * as http from 'node:http';
import * as https from 'node:https';
import { ConnectionError, TokenResolutionError } from '../errors.js';

export interface ParsedTokenUrl {
	origin: string;
	token: string;
}

export function parseTokenUrl(input: string): ParsedTokenUrl {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new ConnectionError(`Invalid URL: ${input}`);
	}
	const token = parsed.searchParams.get('token');
	if (!token) {
		throw new ConnectionError(`URL is missing 'token' query parameter: ${input}`);
	}
	return { origin: parsed.origin, token };
}

export type TokenTransport = 'vnc' | 'webrtc';

interface ProbeResponse {
	status: number;
	body: string;
}

function probe(url: string): Promise<ProbeResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const lib = parsed.protocol === 'https:' ? https : http;
		const req = lib.request(
			url,
			{ method: 'GET', rejectUnauthorized: false } as https.RequestOptions,
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
				);
				res.on('error', reject);
			},
		);
		req.on('error', reject);
		req.end();
	});
}

export async function fetchTokenType(origin: string, token: string): Promise<TokenTransport> {
	const url = `${origin}/api/token-info?token=${encodeURIComponent(token)}`;
	let res: ProbeResponse;
	try {
		res = await probe(url);
	} catch (err) {
		throw new ConnectionError(
			`Failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (res.status === 404) {
		throw new TokenResolutionError(token, 'unknown token (404 from /api/token-info)');
	}
	if (res.status < 200 || res.status >= 300) {
		throw new ConnectionError(`/api/token-info returned HTTP ${res.status}: ${res.body}`);
	}
	let body: { type?: string };
	try {
		body = JSON.parse(res.body) as { type?: string };
	} catch (err) {
		throw new ConnectionError(
			`/api/token-info returned non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const type = (body.type ?? 'vnc').toLowerCase();
	if (type !== 'vnc' && type !== 'webrtc') {
		throw new ConnectionError(`Unexpected token type from /api/token-info: ${type}`);
	}
	return type as TokenTransport;
}

export function buildVncWsUrl(origin: string, token: string): string {
	const wsOrigin = origin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
	return `${wsOrigin}/?token=${encodeURIComponent(token)}`;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBMISSION_PATH_REGEX =
	/\/submission\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

const DEFAULT_CLOUDVNC_HOST = 'app.threat.zone';

/**
 * Result of parsing the `connect.url` argument.
 * - 'cloudvnc' goes through the legacy /api/token-info probe (supports webrtc routing).
 * - 'websockify' is a pre-resolved wss URL that goes straight to the websockify connect flow.
 */
export type NormalizedConnect =
	| { kind: 'cloudvnc'; origin: string; token: string }
	| { kind: 'websockify'; wsUrl: string };

/**
 * Accepts:
 *   - bare UUID                                  → wss://app.threat.zone/cloudvnc?token=UUID
 *   - https://<host>/submission/<UUID>[/...]     → wss://<host>/cloudvnc?token=UUID
 *   - ws://<host>/cloudvnc?token=UUID            → wss://<host>/cloudvnc?token=UUID (upgraded)
 *   - wss://<host>/...?token=UUID                → pass through
 *   - https://<host>/cloudvnc?token=UUID         → cloudvnc (existing /api/token-info probe)
 */
export function normalizeConnectInput(input: string): NormalizedConnect {
	const trimmed = input.trim();

	if (UUID_REGEX.test(trimmed)) {
		return {
			kind: 'websockify',
			wsUrl: `wss://${DEFAULT_CLOUDVNC_HOST}/cloudvnc?token=${trimmed}`,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new ConnectionError(
			`Invalid input — expected UUID, submission URL, cloudvnc URL, or websockify URL: ${input}`,
		);
	}

	const submissionMatch = parsed.pathname.match(SUBMISSION_PATH_REGEX);
	if (submissionMatch) {
		const token = submissionMatch[1];
		const wssOrigin = parsed.origin.replace(/^https?:/i, 'wss:');
		return {
			kind: 'websockify',
			wsUrl: `${wssOrigin}/cloudvnc?token=${encodeURIComponent(token)}`,
		};
	}

	if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
		// Upgrade ws → wss; preserve path/query verbatim.
		const upgraded = trimmed.replace(/^ws:/i, 'wss:');
		return { kind: 'websockify', wsUrl: upgraded };
	}

	if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
		const token = parsed.searchParams.get('token');
		if (!token) {
			throw new ConnectionError(`URL is missing 'token' query parameter: ${input}`);
		}
		return { kind: 'cloudvnc', origin: parsed.origin, token };
	}

	throw new ConnectionError(`Unsupported URL protocol '${parsed.protocol}': ${input}`);
}
