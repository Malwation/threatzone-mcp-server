import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import {
	existsSync,
	promises as fsp,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerApiTools } from '../src/api/register.js';
import type { TransportMode } from '../src/shared/tool-context.js';

const API_TOKEN = 'tz_real-secret-token-0123456789';
const UUID = '11111111-1111-4111-8111-111111111111';
const BIG_UUID = '22222222-2222-4222-8222-222222222222';
const SMALL_BYTES = Buffer.from('small sample bytes');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const YARA_TEXT = 'rule test_rule { condition: true }';
const DECLARED_SIZE = 30 * 1024 * 1024;

const DOWNLOAD_TOOLS = [
	'tz_download_sample',
	'tz_download_artifact',
	'tz_download_pcap',
	'tz_download_yara_rule',
	'tz_download_html_report',
	'tz_download_cdr',
	'tz_download_screenshot',
	'tz_download_media',
];
const FILE_SUBMIT_TOOLS = ['tz_submit_sandbox', 'tz_submit_static', 'tz_submit_cdr'];

/** Tracks one streamed oversize response: how much the server wrote and whether the client hung up. */
interface StreamProbe {
	bytesWritten: number;
	closed: Promise<void>;
}

let probe: StreamProbe | undefined;
const submissions: { path: string; body: Buffer }[] = [];

function trackResponse(res: http.ServerResponse): StreamProbe {
	const current: StreamProbe = {
		bytesWritten: 0,
		closed: once(res, 'close').then(() => undefined),
	};
	probe = current;
	return current;
}

// Sends one 64 KB chunk and then stalls: a client that reads the whole body never finishes.
function sendHeadAndStall(res: http.ServerResponse, headers: http.OutgoingHttpHeaders): void {
	const current = trackResponse(res);
	res.writeHead(200, headers);
	const chunk = Buffer.alloc(64 * 1024, 0x41);
	current.bytesWritten += chunk.byteLength;
	res.write(chunk);
}

// Streams 1 MB chunks with no Content-Length until the client hangs up.
function streamChunkedForever(res: http.ServerResponse): void {
	const current = trackResponse(res);
	res.writeHead(200, { 'Content-Type': 'text/html' });
	const chunk = Buffer.alloc(1024 * 1024, 0x42);
	const pump = (): void => {
		while (!res.destroyed) {
			current.bytesWritten += chunk.byteLength;
			if (!res.write(chunk)) {
				res.once('drain', pump);
				return;
			}
		}
	};
	pump();
}

const api = http.createServer((req, res) => {
	const url = req.url ?? '';
	if (req.method === 'POST') {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			submissions.push({ path: url, body: Buffer.concat(chunks) });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ uuid: UUID, message: 'ok' }));
		});
		return;
	}
	if (url === `/public-api/submissions/${BIG_UUID}/download/pcap`) {
		return sendHeadAndStall(res, {
			'Content-Type': 'application/vnd.tcpdump.pcap',
			'Content-Length': String(DECLARED_SIZE),
			'Content-Disposition': 'attachment; filename="capture.pcap"',
		});
	}
	if (url === `/public-api/submissions/${BIG_UUID}/download/html-report`) {
		return streamChunkedForever(res);
	}
	if (url === `/public-api/submissions/${UUID}/screenshot`) {
		res.writeHead(200, { 'Content-Type': 'image/png' });
		return res.end(PNG_BYTES);
	}
	if (url === `/public-api/submissions/${UUID}/download/yara-rule`) {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		return res.end(YARA_TEXT);
	}
	if (url.startsWith(`/public-api/submissions/${UUID}/download/`)) {
		res.writeHead(200, {
			'Content-Type': 'application/zip',
			'Content-Disposition': 'attachment; filename="sample.zip"',
		});
		return res.end(SMALL_BYTES);
	}
	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ statusCode: 404, message: 'Not found', code: 'NOT_FOUND' }));
});

let apiBase = '';
let workDir = '';

async function connectClient(transportMode: TransportMode): Promise<Client> {
	const server = new McpServer({ name: 'test', version: '0.0.0' });
	registerApiTools(server, { transportMode });
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: 'test-client', version: '0.0.0' });
	await client.connect(clientSide);
	return client;
}

async function call(
	client: Client,
	name: string,
	args: Record<string, unknown>,
): Promise<CallToolResult> {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
	return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

before(async () => {
	await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
	const { port } = api.address() as AddressInfo;
	apiBase = `http://127.0.0.1:${port}/public-api`;
	process.env.THREATZONE_API_BASE_URL = apiBase;
	process.env.THREATZONE_API_TOKEN = API_TOKEN;
});

after(() => {
	api.closeAllConnections();
	api.close();
});

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'tz-mcp-file-access-'));
	submissions.length = 0;
	probe = undefined;
});

afterEach(() => {
	mock.restoreAll();
	rmSync(workDir, { recursive: true, force: true });
});

test('HTTP mode: tools/list hides save_to and file_path', async () => {
	const client = await connectClient('http');
	const { tools } = await client.listTools();
	for (const name of DOWNLOAD_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `${name} is registered`);
		assert.ok(!('save_to' in (tool.inputSchema.properties ?? {})), `${name} has no save_to`);
		assert.ok(!tool.description?.includes('save_to'), `${name} description has no save_to`);
	}
	for (const name of FILE_SUBMIT_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `${name} is registered`);
		const props = tool.inputSchema.properties ?? {};
		assert.ok(!('file_path' in props), `${name} has no file_path`);
		assert.ok('file_base64' in props, `${name} keeps file_base64`);
		assert.ok(!JSON.stringify(props).includes('file_path'), `${name} schema text has no file_path`);
	}
});

test('stdio mode: tools/list keeps save_to and file_path', async () => {
	const client = await connectClient('stdio');
	const { tools } = await client.listTools();
	for (const name of DOWNLOAD_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool && 'save_to' in (tool.inputSchema.properties ?? {}), `${name} has save_to`);
	}
	for (const name of FILE_SUBMIT_TOOLS) {
		const tool = tools.find((t) => t.name === name);
		const props = tool?.inputSchema.properties ?? {};
		assert.ok('file_path' in props && 'file_base64' in props, `${name} has both file sources`);
	}
});

test('HTTP mode: oversize download returns the URL and token instruction without reading the body', {
	timeout: 10_000,
}, async () => {
	const client = await connectClient('http');
	// The mock stalls after 64 KB of a declared 30 MB body: this call returns only if the body is not read.
	const result = await call(client, 'tz_download_pcap', {
		uuid: BIG_UUID,
		api_token: 'tz_per-call-secret-override',
	});
	assert.equal(result.isError, undefined);
	const body = text(result);
	const url = `${apiBase}/submissions/${BIG_UUID}/download/pcap`;
	assert.match(body, /30\.0 MB, over the 25 MB inline cap/);
	assert.ok(body.includes('Method: GET'));
	assert.ok(body.includes(`URL: ${url}`));
	assert.ok(body.includes('same Threat.Zone API token you use for this MCP server'));
	assert.ok(body.includes('`Authorization: Bearer <your API token>`'));
	assert.ok(
		body.includes(`curl -H "Authorization: Bearer <YOUR_API_TOKEN>" -o 'capture.pcap' '${url}'`),
	);
	assert.ok(!body.includes(API_TOKEN), 'env token is not in the result');
	assert.ok(!body.includes('tz_per-call-secret-override'), 'per-call token is not in the result');

	const current = probe;
	assert.ok(current);
	await current.closed;
	assert.equal(current.bytesWritten, 64 * 1024);
});

test('HTTP mode: body without Content-Length stops at the inline limit', {
	timeout: 10_000,
}, async () => {
	const client = await connectClient('http');
	const result = await call(client, 'tz_download_html_report', { uuid: BIG_UUID });
	const body = text(result);
	assert.match(body, /File too large to return inline \(over the 25 MB inline cap\)/);
	assert.ok(body.includes(`'${BIG_UUID}.html'`));
	assert.ok(body.includes(`${apiBase}/submissions/${BIG_UUID}/download/html-report`));
	assert.ok(!body.includes(API_TOKEN));
	const current = probe;
	assert.ok(current);
	await current.closed;
});

test('HTTP mode: small file returns inline base64', async () => {
	const client = await connectClient('http');
	const result = await call(client, 'tz_download_sample', { uuid: UUID });
	const parsed = JSON.parse(text(result));
	assert.deepEqual(parsed, {
		data: SMALL_BYTES.toString('base64'),
		mimetype: 'application/zip',
		filename: 'sample.zip',
		size: SMALL_BYTES.byteLength,
	});
});

test('HTTP mode: screenshot returns an image block, YARA rule returns inline base64', async () => {
	const client = await connectClient('http');
	const shot = await call(client, 'tz_download_screenshot', { uuid: UUID });
	assert.deepEqual(shot.content, [
		{ type: 'image', data: PNG_BYTES.toString('base64'), mimeType: 'image/png' },
	]);
	const yara = JSON.parse(text(await call(client, 'tz_download_yara_rule', { uuid: UUID })));
	assert.equal(Buffer.from(yara.data, 'base64').toString(), YARA_TEXT);
});

test('HTTP mode: save_to sent anyway does not write to disk', async () => {
	const writeSpy = mock.method(fsp, 'writeFile');
	const client = await connectClient('http');
	const target = join(workDir, 'should-not-exist.zip');
	const result = await call(client, 'tz_download_sample', { uuid: UUID, save_to: target });
	assert.equal(JSON.parse(text(result)).data, SMALL_BYTES.toString('base64'));
	assert.equal(existsSync(target), false);
	assert.equal(writeSpy.mock.callCount(), 0);
});

test('HTTP mode: file_path sent anyway is not read', async () => {
	const statSpy = mock.method(fsp, 'stat');
	const readSpy = mock.method(fsp, 'readFile');
	const secret = join(workDir, 'secret.txt');
	writeFileSync(secret, 'server-side secret');
	const client = await connectClient('http');

	const rejected = await call(client, 'tz_submit_static', { file_path: secret });
	assert.equal(rejected.isError, true);
	assert.match(text(rejected), /INVALID_FILE_SOURCE/);
	assert.equal(submissions.length, 0);

	const inline = Buffer.from('inline content');
	const accepted = await call(client, 'tz_submit_sandbox', {
		file_path: secret,
		file_base64: inline.toString('base64'),
		filename: 'inline.bin',
	});
	assert.equal(accepted.isError, undefined);
	assert.equal(submissions.length, 1);
	assert.ok(submissions[0].body.includes(inline));
	assert.ok(!submissions[0].body.includes(Buffer.from('server-side secret')));

	assert.equal(statSpy.mock.callCount(), 0);
	assert.equal(readSpy.mock.callCount(), 0);
});

test('stdio mode: save_to writes the file and file_path reads it', async () => {
	// Same spies as the HTTP tests: proves they see the disk calls when they happen.
	const writeSpy = mock.method(fsp, 'writeFile');
	const readSpy = mock.method(fsp, 'readFile');
	const client = await connectClient('stdio');
	const target = join(workDir, 'saved.zip');
	const saved = JSON.parse(
		text(await call(client, 'tz_download_sample', { uuid: UUID, save_to: target })),
	);
	assert.deepEqual(saved, {
		saved: true,
		path: target,
		size: SMALL_BYTES.byteLength,
		mimetype: 'application/zip',
	});
	assert.deepEqual(readFileSync(target), SMALL_BYTES);
	assert.equal(writeSpy.mock.callCount(), 1);

	const source = join(workDir, 'upload.bin');
	writeFileSync(source, 'local file content');
	const result = await call(client, 'tz_submit_static', { file_path: source });
	assert.equal(result.isError, undefined);
	assert.equal(submissions.length, 1);
	assert.equal(submissions[0].path, '/public-api/submissions/static');
	assert.ok(submissions[0].body.includes(Buffer.from('local file content')));
	assert.ok(submissions[0].body.includes(Buffer.from('filename="upload.bin"')));
	assert.equal(readSpy.mock.callCount(), 1);
});
