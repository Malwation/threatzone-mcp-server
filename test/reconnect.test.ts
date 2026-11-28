import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type WebSocket, WebSocketServer } from 'ws';
import type { RemoteSession } from '../src/shared/remote-session.js';
import type { VncSessionConfig } from '../src/vnc/protocol/protocol-types.js';
import { SessionManager } from '../src/vnc/protocol/session-manager.js';
import { VncClient } from '../src/vnc/protocol/vnc-client.js';
import { registerVncTools } from '../src/vnc/register.js';

const UUID = '33333333-3333-4333-8333-333333333333';
const LIVE_TOKEN = 'gateway-live-token-0123456789abcdef';
const SESSION_ID = createHash('sha256').update(LIVE_TOKEN).digest('hex');

/** RFB server init for an 800x600, 32 bpp true-color screen named "test". */
function serverInit(): Buffer {
	const buf = Buffer.alloc(24 + 4);
	buf.writeUInt16BE(800, 0);
	buf.writeUInt16BE(600, 2);
	buf[4] = 32; // bits per pixel
	buf[5] = 24; // depth
	buf[6] = 0; // little endian
	buf[7] = 1; // true color
	buf.writeUInt16BE(255, 8);
	buf.writeUInt16BE(255, 10);
	buf.writeUInt16BE(255, 12);
	buf[14] = 16;
	buf[15] = 8;
	buf[16] = 0;
	buf.writeUInt32BE(4, 20);
	buf.write('test', 24, 'ascii');
	return buf;
}

/**
 * Stands in for the live-view gateway. `accept`: RFB 3.8 with security type None.
 * `refuse`: the gateway accepts the WebSocket, then closes it with 4401, as it does for an expired token.
 */
let mode: 'accept' | 'refuse' = 'accept';
let upgrades = 0;
const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
gateway.on('connection', (ws: WebSocket) => {
	upgrades++;
	if (mode === 'refuse') {
		ws.close(4401, 'token expired');
		return;
	}
	let step = 0;
	ws.on('message', () => {
		step++;
		if (step === 1) ws.send(Buffer.from([1, 1])); // one security type: None
		if (step === 2) ws.send(Buffer.from([0, 0, 0, 0])); // security result: OK
		if (step === 3) ws.send(serverInit()); // reply to ClientInit
	});
	ws.send(Buffer.from('RFB 003.008\n', 'ascii'));
});

let link = '';
const api = http.createServer((_req, res) => {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ state: 'running', vncAvailable: true, link, expiresAt: null }));
});

const clients: VncClient[] = [];
function createClient(config: VncSessionConfig): RemoteSession {
	const client = new VncClient(config, { connectTimeout: 10_000, screenshotTimeout: 1000 });
	clients.push(client);
	return client;
}

function closed(client: RemoteSession): Promise<void> {
	return new Promise((resolve) => client.onClose(resolve));
}

let mcp: Client;
let manager: SessionManager;

async function call(
	name: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const res = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
	const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
	assert.ok(!text.includes(LIVE_TOKEN), 'no result holds the raw live-view token');
	assert.ok(!text.includes('token='), 'no result holds a token query');
	return { text, isError: res.isError === true };
}

before(async () => {
	await once(gateway, 'listening');
	const gatewayPort = (gateway.address() as AddressInfo).port;
	link = `ws://127.0.0.1:${gatewayPort}/cloudvnc?token=${LIVE_TOKEN}`;
	await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
	process.env.THREATZONE_API_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}/public-api`;
	process.env.THREATZONE_API_TOKEN = 'tz_test-token';

	manager = new SessionManager({ defaultSession: false, idleTimeoutMs: null, createClient });
	const server = new McpServer({ name: 'test', version: '0.0.0' });
	registerVncTools(server, { transportMode: 'http' }, manager);
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	mcp = new Client({ name: 'test-client', version: '0.0.0' });
	await mcp.connect(clientSide);
});

after(async () => {
	manager.disconnectAll();
	await mcp.close();
	for (const ws of gateway.clients) ws.terminate();
	gateway.close();
	api.close();
});

test('gateway: a closed live view reconnects, and a refused reconnect fails fast with the close code', async () => {
	const connected = await call('connect', { submission_uuid: UUID });
	assert.equal(connected.isError, false, connected.text);
	assert.ok(connected.text.includes(`'${SESSION_ID}'`));
	assert.match(connected.text, /Screen size: 800x600/);
	assert.equal(upgrades, 1);

	// Run keeps going, network drops: the next call dials the same link again.
	let drop = closed(clients[0]);
	for (const ws of gateway.clients) ws.close(1001, 'going away');
	await drop;
	const size = await call('get_screen_size', { session_id: SESSION_ID });
	assert.equal(size.text, '{"width":800,"height":600}');
	assert.equal(upgrades, 2);
	assert.equal(clients.length, 2);

	// Run ends: the gateway now refuses the token.
	drop = closed(clients[1]);
	for (const ws of gateway.clients) ws.close(1000);
	await drop;
	mode = 'refuse';
	const started = Date.now();
	const ended = await call('screenshot', { session_id: SESSION_ID });
	const elapsed = Date.now() - started;
	assert.equal(ended.isError, true);
	assert.match(ended.text, /live view of this session ended/);
	assert.match(ended.text, /code 4401 \(token expired\)/);
	assert.ok(elapsed < 2000, `refused reconnect took ${elapsed} ms`);

	const gone = await call('screenshot', { session_id: SESSION_ID });
	assert.match(gone.text, /Session not found or ended/);
	assert.equal(upgrades, 3, 'the removed session is not dialed again');
});

for (const [signal, code] of [
	['SIGINT', 130],
	['SIGTERM', 143],
] as const) {
	test(`shutdown: ${signal} closes the sessions and exits with ${code}`, async () => {
		const shutdownModule = join(__dirname, '..', 'src', 'shutdown.js');
		const child = spawn(
			process.execPath,
			[
				'-e',
				`require(${JSON.stringify(shutdownModule)}).installShutdownHandlers({ disconnectAll() { console.error('sessions closed'); } });
				console.error('ready');
				setInterval(() => {}, 1000);`,
			],
			{ stdio: ['ignore', 'ignore', 'pipe'] },
		);
		let stderr = '';
		const ready = new Promise<void>((resolve) => {
			child.stderr.on('data', (chunk: Buffer) => {
				stderr += chunk.toString();
				if (stderr.includes('ready')) resolve();
			});
		});
		const exited = once(child, 'exit');
		await ready;
		child.kill(signal);
		const [exitCode] = await exited;
		assert.equal(exitCode, code);
		assert.match(stderr, /sessions closed/);
	});
}
