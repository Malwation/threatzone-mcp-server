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
