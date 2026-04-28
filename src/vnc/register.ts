import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult } from './errors.js';
import { SessionManager } from './protocol/session-manager.js';
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

const sessionManager = new SessionManager();

export function registerVncTools(server: McpServer): void {
	// --- connect ---
	server.tool(
		'connect',
		'Connect to a Threat.Zone session by submission UUID, submission URL, cloudvnc URL, or raw websockify URL',
		{
			url: z
				.string()
				.optional()
				.describe(
					'One of: bare submission UUID (e.g. 9a6f8a57-…); submission page URL (https://app.threat.zone/submission/<UUID>[/dynamic-scan-report]); cloudvnc URL (https://app.threat.zone/cloudvnc?token=UUID — probes /api/token-info to route VNC vs WebRTC); or ws/wss URL (ws:// is auto-upgraded to wss://). Bare UUIDs default to host app.threat.zone.',
				),
			ws_url: z
				.string()
				.optional()
				.describe(
					'Raw websockify URL when you already have one (e.g. wss://host:9191/?token=UUID). Use `url` instead unless you know you need this.',
				),
			ws_cookie: z
				.string()
				.optional()
				.describe(
					'Cookie header value for authenticated websockify connections (paired with ws_url)',
				),
			session_id: z.string().optional().describe('Custom session identifier'),
		},
		async (args) => {
			try {
				return await handleConnect(args, sessionManager);
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
			session_id: z
				.string()
				.optional()
				.describe('Session to disconnect (uses active session if omitted)'),
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
			session_id: z.string().optional().describe('Session ID'),
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
		async (args) => {
			try {
				return await handleScreenshot(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleSendKey(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleTypeText(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleMouseClick(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- mouse_move ---
	server.tool(
		'mouse_move',
		'Move the mouse cursor to a specific position',
		{
			x: z.coerce.number().describe('X coordinate'),
			y: z.coerce.number().describe('Y coordinate'),
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleMouseMove(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleMouseDrag(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleScroll(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- get_screen_size ---
	server.tool(
		'get_screen_size',
		'Get the VNC screen dimensions',
		{
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleGetScreenSize(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
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
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleWaitForScreenChange(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- file_upload ---
	server.tool(
		'file_upload',
		'Upload a base64-encoded file to the remote machine via clipboard + shell commands',
		{
			localBase64: z.string().describe('Base64-encoded file content'),
			remotePath: z.string().describe('Destination file path on the remote machine'),
			os: z.enum(['windows', 'linux']).optional().describe('Remote OS (default: windows)'),
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleFileUpload(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- file_download ---
	server.tool(
		'file_download',
		'Download a file from the remote machine as base64 via clipboard + shell commands',
		{
			remotePath: z.string().describe('File path on the remote machine to download'),
			os: z.enum(['windows', 'linux']).optional().describe('Remote OS (default: windows)'),
			session_id: z.string().optional().describe('Session ID'),
		},
		async (args) => {
			try {
				return await handleFileDownload(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- clipboard_write ---
	server.tool(
		'clipboard_write',
		"Send text to the remote machine's clipboard (UTF-8 with Extended Clipboard, Latin-1 fallback)",
		{
			text: z.string().describe('Text to place on the remote clipboard'),
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleClipboardWrite(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- device_button ---
	server.tool(
		'device_button',
		'Press an Android device button (RTC sessions only)',
		{
			button: z.enum(['back', 'home', 'power']).describe('Which physical device button to press'),
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleDeviceButton(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);

	// --- clipboard_read ---
	server.tool(
		'clipboard_read',
		'Read the last clipboard text received from the remote machine',
		{
			session_id: z.string().optional().describe('Session ID'),
		},
		(args) => {
			try {
				return handleClipboardRead(args, sessionManager);
			} catch (err) {
				return errorResult(err);
			}
		},
	);
}
