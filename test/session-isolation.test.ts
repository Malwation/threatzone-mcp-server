import * as assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerApiTools } from '../src/api/register.js';
import { createHttpApp } from '../src/http-app.js';
import type { RemoteSession, RemoteSessionState } from '../src/shared/remote-session.js';
import type { TransportMode } from '../src/shared/tool-context.js';
import type { VncSessionConfig } from '../src/vnc/protocol/protocol-types.js';
import { SESSION_IDLE_TIMEOUT_MS, SessionManager } from '../src/vnc/protocol/session-manager.js';
import { registerVncTools } from '../src/vnc/register.js';

const API_TOKEN = 'tz_api-token-for-tests';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const LIVE_TOKEN_A = 'live-view-token-AAAAAAAAAAAAAAAA';
const LINK_A = `wss://live.example.test/cloudvnc?token=${LIVE_TOKEN_A}`;
const ID_A = createHash('sha256').update(LIVE_TOKEN_A).digest('hex');

const SESSION_TOOLS = [
	'disconnect',
	'screenshot',
	'send_key',
	'type_text',
	'mouse_click',
	'mouse_move',
	'mouse_drag',
	'scroll',
	'get_screen_size',
	'wait_for_screen_change',
	'file_upload',
	'file_download',
	'clipboard_write',
	'device_button',
	'clipboard_read',
];

/** Stands in for VncClient: records dials, pointer events and disconnects. */
class FakeClient implements RemoteSession {
	readonly transport = 'vnc' as const;
	state: RemoteSessionState = 'disconnected';
	screenSize = { width: 1024, height: 768 };
	pointer: [number, number][] = [];
	disconnects = 0;
	private listeners: (() => void)[] = [];

	constructor(readonly config: VncSessionConfig) {}

	async connect(): Promise<void> {
		this.state = 'connected';
	}
	disconnect(): void {
		this.disconnects++;
		this.state = 'disconnected';
	}
	onClose(listener: () => void): void {
		this.listeners.push(listener);
	}
	/** The gateway closes the socket, for example at the end of the run. */
	remoteClose(): void {
		this.state = 'disconnected';
		for (const listener of this.listeners) listener();
	}
	async screenshot(): Promise<Buffer> {
		return Buffer.alloc(0);
	}
	async waitForRect(): Promise<boolean> {
		return false;
	}
	sendKey(): void {
		// Not used by these tests.
	}
	sendPointer(x: number, y: number): void {
		this.pointer.push([x, y]);
	}
	sendDeviceButton(): void {
		// Not used by these tests.
	}
	updateClipboard(): void {
		// Not used by these tests.
	}
	getClipboard(): string | null {
		return null;
	}
	requestFramebufferUpdate(): void {
		// Not used by these tests.
	}
}

let dialed: FakeClient[] = [];
function createClient(config: VncSessionConfig): FakeClient {
	const client = new FakeClient(config);
	dialed.push(client);
	return client;
}

const api = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'application/json' });
	if (req.url === `/public-api/submissions/${UUID_A}/dynamic/session`) {
		res.end(
			JSON.stringify({ state: 'running', vncAvailable: true, link: LINK_A, expiresAt: null }),
		);
		return;
	}
	res.writeHead(404);
	res.end(JSON.stringify({ statusCode: 404, message: 'Submission not found', code: 'NOT_FOUND' }));
});

let mcpUrl: URL;
let mcpServer: http.Server;
let sessions: SessionManager;
const clients: Client[] = [];
const seenText: string[] = [];

async function connectHttpClient(): Promise<Client> {
	const client = new Client({ name: 'test-client', version: '0.0.0' });
	await client.connect(new StreamableHTTPClientTransport(mcpUrl));
	clients.push(client);
	return client;
}

async function connectInMemory(mode: TransportMode, manager: SessionManager): Promise<Client> {
	const server = new McpServer({ name: 'test', version: '0.0.0' });
	registerVncTools(server, { transportMode: mode }, manager);
	registerApiTools(server, { transportMode: mode });
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: 'test-client', version: '0.0.0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

/** Calls a tool. A schema rejection counts as an error result, whether the SDK throws or returns it. */
async function call(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	let result: { text: string; isError: boolean };
	try {
		const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
		result = {
			text: res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
			isError: res.isError === true,
		};
	} catch (err) {
		result = { text: err instanceof Error ? err.message : String(err), isError: true };
	}
	seenText.push(result.text);
	return result;
}

before(async () => {
	await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
	const { port } = api.address() as AddressInfo;
	process.env.THREATZONE_API_BASE_URL = `http://127.0.0.1:${port}/public-api`;
	process.env.THREATZONE_API_TOKEN = API_TOKEN;

	sessions = new SessionManager({ defaultSession: false, idleTimeoutMs: 60_000, createClient });
	const app = createHttpApp({
		serverVersion: '0.0.0',
		toolContext: { transportMode: 'http' },
		sessionManager: sessions,
	});
	mcpServer = app.listen(0, '127.0.0.1');
	await new Promise<void>((resolve) => mcpServer.once('listening', resolve));
	mcpUrl = new URL(`http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`);
});

after(async () => {
	for (const client of clients) await client.close();
	mcpServer.closeAllConnections();
	mcpServer.close();
	api.close();
	for (const text of seenText) {
		assert.ok(!text.includes(LIVE_TOKEN_A), 'no result holds the raw live-view token');
		assert.ok(!text.includes('token='), 'no result holds a token query');
	}
});

beforeEach(() => {
	dialed = [];
	sessions.disconnectAll();
});

test('HTTP: a second MCP session cannot reach a session without its ID', async () => {
	const a = await connectHttpClient();
	const b = await connectHttpClient();

	const connected = await call(a, 'connect', { submission_uuid: UUID_A });
	assert.equal(connected.isError, false, connected.text);
	assert.ok(connected.text.includes(`'${ID_A}'`));
	assert.match(connected.text, /Screen size: 1024x768/);

	for (const [name, args] of [
		['screenshot', {}],
		['mouse_move', { x: 5, y: 5 }],
		['disconnect', {}],
	] as const) {
		const missing = await call(b, name, args);
		assert.equal(missing.isError, true, `${name} without session_id fails`);
		assert.match(missing.text, /session_id/);

		const guessed = await call(b, name, { ...args, session_id: randomBytes(32).toString('hex') });
		assert.equal(guessed.isError, true, `${name} with a random ID fails`);
		assert.match(guessed.text, /Session not found or ended/);
	}

	const size = await call(a, 'get_screen_size', { session_id: ID_A });
	assert.equal(size.text, '{"width":1024,"height":768}');
	assert.equal((await call(a, 'mouse_move', { x: 7, y: 8, session_id: ID_A })).isError, false);
	assert.equal(dialed.length, 1);
	assert.deepEqual(dialed[0].pointer, [[7, 8]]);
	assert.equal(dialed[0].disconnects, 0);
});

test('HTTP: connect twice for the same link returns the same ID with one dial', async () => {
	const a = await connectHttpClient();
	const first = await call(a, 'connect', { submission_uuid: UUID_A });
	const second = await call(a, 'connect', { submission_uuid: UUID_A });
	assert.ok(first.text.includes(`'${ID_A}'`));
	assert.ok(second.text.includes(`'${ID_A}'`));
	assert.match(second.text, /Reusing the connected VNC session/);
	assert.equal(dialed.length, 1);
	assert.equal(dialed[0].config.wsUrl, LINK_A);
});

test('HTTP: the session is removed when the socket closes', async () => {
	const a = await connectHttpClient();
	await call(a, 'connect', { submission_uuid: UUID_A });
	dialed[0].remoteClose();

	const ended = await call(a, 'get_screen_size', { session_id: ID_A });
	assert.equal(ended.isError, true);
	assert.match(ended.text, /Session not found or ended/);

	const again = await call(a, 'connect', { submission_uuid: UUID_A });
	assert.ok(again.text.includes(`'${ID_A}'`));
	assert.equal(dialed.length, 2);
});

test('HTTP: tool schemas hide raw URL inputs and require session_id', async () => {
	const client = await connectInMemory('http', new SessionManager({ defaultSession: false }));
	const { tools } = await client.listTools();
	const connect = tools.find((t) => t.name === 'connect');
	assert.ok(connect);
	assert.deepEqual(Object.keys(connect.inputSchema.properties ?? {}).sort(), [
		'api_token',
		'submission_uuid',
	]);
	assert.deepEqual(connect.inputSchema.required, ['submission_uuid']);
	for (const name of SESSION_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `${name} is registered`);
		assert.ok(tool.inputSchema.required?.includes('session_id'), `${name} requires session_id`);
	}
});

test('stdio: tools/list is the same as on main', async () => {
	const client = await connectInMemory('stdio', new SessionManager());
	const { tools } = await client.listTools();
	const fixture = join(__dirname, '..', '..', 'test', 'fixtures', 'stdio-tools.main.json');
	// JSON round trip drops the undefined fields that the in-memory transport keeps.
	assert.deepEqual(JSON.parse(JSON.stringify(tools)), JSON.parse(readFileSync(fixture, 'utf-8')));
});

test('stdio: the default session works and a reused session_id closes the old client', async () => {
	const manager = new SessionManager({ createClient });
	const client = await connectInMemory('stdio', manager);

	assert.equal(
		(await call(client, 'connect', { ws_url: 'wss://vm.example.test/ws' })).isError,
		false,
	);
	const size = await call(client, 'get_screen_size', {});
	assert.equal(size.text, '{"width":1024,"height":768}');

	await call(client, 'connect', { ws_url: 'wss://vm.example.test/one', session_id: 'mine' });
	await call(client, 'connect', { ws_url: 'wss://vm.example.test/two', session_id: 'mine' });
	assert.equal(dialed.length, 3);
	assert.equal(dialed[1].disconnects, 1, 'the old client with the same ID is closed');
	assert.equal(dialed[2].disconnects, 0);
	await call(client, 'mouse_move', { x: 1, y: 2, session_id: 'mine' });
	assert.deepEqual(dialed[2].pointer, [[1, 2]]);
	manager.disconnectAll();
});

test('SessionManager: idle timeout closes the session, and HTTP mode has no default session', async () => {
	assert.equal(SESSION_IDLE_TIMEOUT_MS, 5 * 60 * 1000);
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		const manager = new SessionManager({
			defaultSession: false,
			idleTimeoutMs: 1000,
			createClient,
		});
		const config = { host: 'h', port: 443, wsUrl: LINK_A, sessionId: ID_A };
		await manager.connectOrReuse(config);
		assert.throws(() => manager.getSession(), /Session not found or ended/);

		mock.timers.tick(999);
		manager.getSession(ID_A);
		mock.timers.tick(999);
		assert.equal(manager.getSession(ID_A), dialed[0], 'each tool call resets the idle timer');
		mock.timers.tick(1000);
		assert.throws(() => manager.getSession(ID_A), /Session not found or ended/);
		assert.equal(dialed[0].disconnects, 1);
	} finally {
		mock.timers.reset();
	}
});
