import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ToolContext } from '../shared/tool-context.js';
import { errorResult } from './errors.js';
import type { SessionManager } from './protocol/session-manager.js';
import { handleClipboardRead } from './tools/clipboard-read.js';
import { handleClipboardWrite } from './tools/clipboard-write.js';
import { handleConnect } from './tools/connect.js';
import { handleDeviceButton } from './tools/device-button.js';
import { handleDisconnect } from './tools/disconnect.js';
import { handleFileDownload } from './tools/file-download.js';
import { handleFileUpload } from './tools/file-upload.js';
import { handleGetScreenSize } from './tools/get-screen-size.js';
import { handleMouseClick } from './tools/mouse-click.js';
import { handleMouseDrag } from './tools/mouse-drag.js';
import { handleMouseMove } from './tools/mouse-move.js';
import { handleScreenshot } from './tools/screenshot.js';
import { handleScroll } from './tools/scroll.js';
import { handleSendKey } from './tools/send-key.js';
import { handleTypeText } from './tools/type-text.js';
import { handleWaitForScreenChange } from './tools/wait-for-screen-change.js';

const CONNECT_DESCRIPTION_BASE =
	'Open the live view of a running Threat.Zone sandbox run. Pass `submission_uuid`: the server gets the live-view link from the Public API (`GET /submissions/{uuid}/dynamic/session`) and connects. Only the submitter or a workspace admin gets a link. URL-analysis live sessions are not supported yet.';

const stdioConnectSchema = {
	submission_uuid: z
		.string()
		.uuid()
		.optional()
		.describe('UUID of a sandbox (file) submission whose run is in progress'),
	api_token: z
		.string()
		.optional()
		.describe('Override THREATZONE_API_TOKEN env var for this call (used with submission_uuid)'),
	url: z
		.string()
		.optional()
		.describe(
			'Raw ws:// or wss:// VNC WebSocket URL. The scheme is kept as given. Submission UUIDs and submission page URLs are not accepted here: use `submission_uuid`.',
		),
	ws_url: z
		.string()
		.optional()
		.describe(
			'Raw websockify URL when you already have one (e.g. wss://host:9191/?token=...). Use with `ws_cookie` if the endpoint needs a cookie.',
		),
	ws_cookie: z
		.string()
		.optional()
		.describe('Cookie header value for authenticated websockify connections (paired with ws_url)'),
	session_id: z.string().optional().describe('Custom session identifier'),
};

// HTTP mode: the server derives the session ID from the live-view link, so the caller cannot pick it.
const httpConnectSchema = {
	submission_uuid: z
		.string()
		.uuid()
		.describe('UUID of a sandbox (file) submission whose run is in progress'),
	api_token: stdioConnectSchema.api_token,
};

const stdioSessionId = z.string().optional().describe('Session ID');
const httpSessionId = z
	.string()
	.describe(
		'Session ID returned by connect (required). If the connection closed, this call reconnects first. After the run ends, the call returns a "live view ended" error.',
	);

export function registerVncTools(
	server: McpServer,
	ctx: ToolContext,
	sessionManager: SessionManager,
): void {
	const http = ctx.transportMode === 'http';
	// HTTP mode has no default session: every session tool needs the ID that connect returned.
	const sessionId = http ? (httpSessionId as unknown as typeof stdioSessionId) : stdioSessionId;

	// Session tools run inside sessionManager.run: it dials a closed session again before the call.
	// The handler gets the ID that run resolved, so the stdio default is resolved only once.
	const withSession =
		<A extends { session_id?: string }>(
			handler: (args: A, sessions: SessionManager) => CallToolResult | Promise<CallToolResult>,
		) =>
		async (args: A): Promise<CallToolResult> => {
			try {
				return await sessionManager.run(args.session_id, (_client, id) =>
					handler({ ...args, session_id: id }, sessionManager),
				);
			} catch (err) {
				return errorResult(err);
			}
		};

	// --- connect ---
	server.tool(
		'connect',
		http
			? `${CONNECT_DESCRIPTION_BASE} The result holds a \`session_id\`: pass it to every session tool. Calling connect again for the same run returns the same \`session_id\`. The connection closes after 5 minutes with no tool call, and the next tool call reconnects. After the run ends, tool calls return a "live view ended" error.`
			: `${CONNECT_DESCRIPTION_BASE} For a WebSocket URL that you already have, pass \`url\` (ws:// or wss://) or \`ws_url\`.`,
		http ? (httpConnectSchema as unknown as typeof stdioConnectSchema) : stdioConnectSchema,
		async (args) => {
			try {
				return await handleConnect(args, sessionManager, ctx);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- disconnect ---
	server.tool(
		'disconnect',
		'Disconnect from a VNC session',
		{
			session_id: http
				? z.string().describe('Session ID returned by connect (required)')
				: z.string().optional().describe('Session to disconnect (uses active session if omitted)'),
		},
		(args) => {
			try {
				return handleDisconnect(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- screenshot ---
	server.tool(
		'screenshot',
		'Capture the current VNC screen as an image',
		{
			session_id: sessionId,
			format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
			quality: z
				.number()
				.min(1)
				.max(100)
				.optional()
				.describe('JPEG quality 1-100 (ignored for PNG)'),
			region: z
				.object({
					x: z.coerce.number(),
					y: z.coerce.number(),
					width: z.coerce.number(),
					height: z.coerce.number(),
				})
				.optional()
				.describe('Capture a specific region (full screen if omitted)'),
		},
		withSession(handleScreenshot),
	);

	// --- send_key ---
	server.tool(
		'send_key',
		'Send a keyboard key press. Supports key names (Return, Escape, F1, a), hex keysyms (0xff0d), and modifiers.',
		{
			key: z.string().describe("Key name (e.g. 'Return', 'a', 'F1') or hex keysym (e.g. '0xff0d')"),
			down: z.boolean().optional().describe('true=press, false=release. Omit for press+release.'),
			modifiers: z
				.array(z.enum(['ctrl', 'alt', 'shift', 'super', 'meta']))
				.optional()
				.describe('Modifier keys to hold during the key press'),
			session_id: sessionId,
		},
		withSession(handleSendKey),
	);

	// --- type_text ---
	server.tool(
		'type_text',
		'Type a string of text character by character',
		{
			text: z.string().describe('Text to type'),
			delay_ms: z.coerce
				.number()
				.optional()
				.describe('Delay between keystrokes in ms (default: 12)'),
			session_id: sessionId,
		},
		withSession(handleTypeText),
	);

	// --- mouse_click ---
	server.tool(
		'mouse_click',
		'Click the mouse at a specific position',
		{
			x: z.coerce.number().describe('X coordinate'),
			y: z.coerce.number().describe('Y coordinate'),
			button: z
				.enum(['left', 'middle', 'right'])
				.optional()
				.describe('Mouse button (default: left)'),
			click_type: z.enum(['single', 'double']).optional().describe('Click type (default: single)'),
			session_id: sessionId,
		},
		withSession(handleMouseClick),
	);

	// --- mouse_move ---
	server.tool(
		'mouse_move',
		'Move the mouse cursor to a specific position',
		{
			x: z.coerce.number().describe('X coordinate'),
			y: z.coerce.number().describe('Y coordinate'),
			session_id: sessionId,
		},
		withSession(handleMouseMove),
	);

	// --- mouse_drag ---
	server.tool(
		'mouse_drag',
		'Drag the mouse from one position to another with button held. Supports bezier curves via controlPoints.',
		{
			startX: z.coerce.number().describe('Starting X coordinate'),
			startY: z.coerce.number().describe('Starting Y coordinate'),
			endX: z.coerce.number().describe('Ending X coordinate'),
			endY: z.coerce.number().describe('Ending Y coordinate'),
			button: z
				.enum(['left', 'middle', 'right'])
				.optional()
				.describe('Mouse button (default: left)'),
			steps: z.coerce
				.number()
				.optional()
				.describe('Interpolation steps along the path (default: 10)'),
			delay_ms: z.coerce.number().optional().describe('Delay between steps in ms (default: 5)'),
			controlPoints: z
				.array(z.object({ x: z.coerce.number(), y: z.coerce.number() }))
				.optional()
				.describe('Bezier control points for curved paths. 0=linear, 1=quadratic, 2=cubic'),
			session_id: sessionId,
		},
		withSession(handleMouseDrag),
	);

	// --- scroll ---
	server.tool(
		'scroll',
		'Scroll the mouse wheel at a specific position',
		{
			x: z.coerce.number().describe('X coordinate'),
			y: z.coerce.number().describe('Y coordinate'),
			direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
			clicks: z.coerce.number().optional().describe('Number of scroll steps (default: 3)'),
			session_id: sessionId,
		},
		withSession(handleScroll),
	);

	// --- get_screen_size ---
	server.tool(
		'get_screen_size',
		'Get the VNC screen dimensions',
		{
			session_id: sessionId,
		},
		withSession(handleGetScreenSize),
	);

	// --- wait_for_screen_change ---
	server.tool(
		'wait_for_screen_change',
		'Wait until the remote screen content changes or timeout',
		{
			timeout_ms: z.coerce.number().optional().describe('Maximum wait time in ms (default: 5000)'),
			region: z
				.object({
					x: z.coerce.number(),
					y: z.coerce.number(),
					width: z.coerce.number(),
					height: z.coerce.number(),
				})
				.optional()
				.describe('Watch only a specific screen region'),
			session_id: sessionId,
		},
		withSession(handleWaitForScreenChange),
	);

	// --- file_upload ---
	server.tool(
		'file_upload',
		'Upload a base64-encoded file to the remote machine via clipboard + shell commands',
		{
			localBase64: z.string().describe('Base64-encoded file content'),
			remotePath: z.string().describe('Destination file path on the remote machine'),
			os: z.enum(['windows', 'linux']).optional().describe('Remote OS (default: windows)'),
			session_id: sessionId,
		},
		withSession(handleFileUpload),
	);

	// --- file_download ---
	server.tool(
		'file_download',
		'Download a file from the remote machine as base64 via clipboard + shell commands',
		{
			remotePath: z.string().describe('File path on the remote machine to download'),
			os: z.enum(['windows', 'linux']).optional().describe('Remote OS (default: windows)'),
			session_id: sessionId,
		},
		withSession(handleFileDownload),
	);

	// --- clipboard_write ---
	server.tool(
		'clipboard_write',
		"Send text to the remote machine's clipboard (UTF-8 with Extended Clipboard, Latin-1 fallback)",
		{
			text: z.string().describe('Text to place on the remote clipboard'),
			session_id: sessionId,
		},
		withSession(handleClipboardWrite),
	);

	// --- device_button ---
	server.tool(
		'device_button',
		'Press an Android device button (RTC sessions only)',
		{
			button: z.enum(['back', 'home', 'power']).describe('Which physical device button to press'),
			session_id: sessionId,
		},
		withSession(handleDeviceButton),
	);

	// --- clipboard_read ---
	server.tool(
		'clipboard_read',
		'Read the last clipboard text received from the remote machine',
		{
			session_id: sessionId,
		},
		withSession(handleClipboardRead),
	);
}
