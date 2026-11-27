import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../src/vnc/protocol/session-manager.js';
import { handleConnect } from '../src/vnc/tools/connect.js';

const API_TOKEN = 'test-api-token';
const LIVE_TOKEN = 'secret-live-view-token-0123456789';
const LINK = `wss://live.example.test/cloudvnc?token=${LIVE_TOKEN}`;

const UUID_RUNNING = '11111111-1111-4111-8111-111111111111';
const UUID_NO_ACCESS = '22222222-2222-4222-8222-222222222222';
const UUID_UNAVAILABLE = '33333333-3333-4333-8333-333333333333';
const UUID_URL_ANALYSIS = '44444444-4444-4444-8444-444444444444';
const UUID_MISSING = '55555555-5555-4555-8555-555555555555';

interface Recorded {
	path: string;
	auth: string | undefined;
}

const requests: Recorded[] = [];

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

const api = http.createServer((req, res) => {
	requests.push({ path: req.url ?? '', auth: req.headers.authorization });
	const match = (req.url ?? '').match(/^\/public-api\/submissions\/([^/]+)\/dynamic\/session$/);
	if (!match) return json(res, 404, { statusCode: 404, message: 'Cannot GET', code: 'NOT_FOUND' });
	switch (match[1]) {
		case UUID_RUNNING:
			return json(res, 200, {
				state: 'running',
				vncAvailable: true,
				link: LINK,
				expiresAt: Date.UTC(2030, 0, 1),
			});
		case UUID_NO_ACCESS:
			return json(res, 200, { state: 'running', vncAvailable: true, link: null, expiresAt: null });
		case UUID_UNAVAILABLE:
			return json(res, 200, {
				state: 'unavailable',
				vncAvailable: false,
				link: null,
				expiresAt: null,
			});
		case UUID_URL_ANALYSIS:
			return json(res, 409, {
				statusCode: 409,
				message: 'Use the URL-analysis session route',
				code: 'URL_ANALYSIS_SUBMISSION',
			});
		default:
			return json(res, 404, {
				statusCode: 404,
				message: 'Submission not found',
				code: 'SUBMISSION_NOT_FOUND',
			});
	}
});

/** Stands in for the WebSocket/VNC layer: records the URL it was asked to dial. */
class FakeSessionManager {
	dialed: string[] = [];
	async connectVnc(config: { wsUrl?: string; sessionId?: string }) {
		this.dialed.push(config.wsUrl ?? '');
		return {
			config: { sessionId: config.sessionId ?? 'fake-session' },
			screenSize: { width: 1024, height: 768 },
		};
	}
}

let sessions: FakeSessionManager;

function run(args: Parameters<typeof handleConnect>[0]): Promise<CallToolResult> {
	return handleConnect(args, sessions as unknown as SessionManager);
}

function text(result: CallToolResult): string {
	return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

before(async () => {
	await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
	const { port } = api.address() as AddressInfo;
	process.env.THREATZONE_API_BASE_URL = `http://127.0.0.1:${port}/public-api`;
	process.env.THREATZONE_API_TOKEN = API_TOKEN;
});

after(() => {
	api.close();
});

beforeEach(() => {
	sessions = new FakeSessionManager();
	requests.length = 0;
});

test('submission_uuid: dials the link from the session route', async () => {
	const result = await run({ submission_uuid: UUID_RUNNING });
	assert.equal(result.isError, undefined);
	assert.deepEqual(sessions.dialed, [LINK]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].path, `/public-api/submissions/${UUID_RUNNING}/dynamic/session`);
	assert.equal(requests[0].auth, `Bearer ${API_TOKEN}`);
	assert.match(text(result), /wss:\/\/live\.example\.test\/cloudvnc/);
	assert.match(text(result), /2030-01-01T00:00:00\.000Z/);
});

test('submission_uuid: api_token arg overrides the env token', async () => {
	await run({ submission_uuid: UUID_RUNNING, api_token: 'override-token' });
	assert.equal(requests[0].auth, 'Bearer override-token');
});

test('submission_uuid: live-view token never appears in the result text', async () => {
	const result = await run({ submission_uuid: UUID_RUNNING });
	assert.ok(!text(result).includes(LIVE_TOKEN));
	assert.ok(!text(result).includes('?token='));
});

test('submission_uuid: live-view token never appears in connect error text', async () => {
	sessions.connectVnc = async () => {
		throw new Error(`WebSocket connection failed: ${LINK} refused`);
	};
	await assert.rejects(run({ submission_uuid: UUID_RUNNING }), (err: Error) => {
		assert.ok(!err.message.includes(LIVE_TOKEN));
		assert.ok(!err.message.includes('?token='));
		return true;
	});
});

test('submission_uuid: link null returns the access error', async () => {
	const result = await run({ submission_uuid: UUID_NO_ACCESS });
	assert.equal(result.isError, true);
	assert.match(text(result), /Only the submitter or a workspace admin/);
	assert.deepEqual(sessions.dialed, []);
});

test('submission_uuid: unavailable returns the not-running error', async () => {
	const result = await run({ submission_uuid: UUID_UNAVAILABLE });
	assert.equal(result.isError, true);
	assert.match(text(result), /not running/);
	assert.deepEqual(sessions.dialed, []);
});

test('submission_uuid: 409 returns the URL-analysis error', async () => {
	const result = await run({ submission_uuid: UUID_URL_ANALYSIS });
	assert.equal(result.isError, true);
	assert.match(text(result), /URL-analysis live sessions/);
	assert.deepEqual(sessions.dialed, []);
});

test('submission_uuid: 404 returns not found', async () => {
	const result = await run({ submission_uuid: UUID_MISSING });
	assert.equal(result.isError, true);
	assert.match(text(result), /SUBMISSION_NOT_FOUND/);
});

test('url: bare UUID is rejected with a pointer to submission_uuid', async () => {
	const result = await run({ url: UUID_RUNNING });
	assert.equal(result.isError, true);
	assert.match(text(result), /submission_uuid/);
	assert.deepEqual(sessions.dialed, []);
	assert.equal(requests.length, 0);
});

test('url: submission page URL is rejected with a pointer to submission_uuid', async () => {
	const result = await run({ url: `https://app.threat.zone/submission/${UUID_RUNNING}` });
	assert.equal(result.isError, true);
	assert.match(text(result), /submission_uuid/);
	assert.deepEqual(sessions.dialed, []);
});

test('url: ws:// scheme is kept as given', async () => {
	const raw = 'ws://127.0.0.1:5900/websockify?token=abc';
	const result = await run({ url: raw });
	assert.equal(result.isError, undefined);
	assert.deepEqual(sessions.dialed, [raw]);
	assert.ok(!text(result).includes('token=abc'));
});
