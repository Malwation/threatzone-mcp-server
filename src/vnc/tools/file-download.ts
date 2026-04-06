import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface FileDownloadArgs {
	remotePath: string;
	os?: 'windows' | 'linux';
	session_id?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleFileDownload(
	args: FileDownloadArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const os = args.os ?? 'windows';
	const keysym = (await import('../protocol/keysym-map.js')).resolveKeysym;

	let cmd: string;
	if (os === 'windows') {
		cmd =
			`powershell -Command "Set-Clipboard ([Convert]::ToBase64String(` +
			`[IO.File]::ReadAllBytes('${args.remotePath}')))"`;

		// Win+R
		client.sendKey(keysym('super_l'), true);
		client.sendKey(keysym('r'), true);
		client.sendKey(keysym('r'), false);
		client.sendKey(keysym('super_l'), false);
		await sleep(500);
	} else {
		cmd = `base64 "${args.remotePath}" | xclip -selection clipboard`;

		// Ctrl+Alt+T
		client.sendKey(keysym('Control_L'), true);
		client.sendKey(keysym('Alt_L'), true);
		client.sendKey(keysym('t'), true);
		client.sendKey(keysym('t'), false);
		client.sendKey(keysym('Alt_L'), false);
		client.sendKey(keysym('Control_L'), false);
		await sleep(1000);
	}

	// Type command
	for (const char of cmd) {
		const ks = keysym(char);
		client.sendKey(ks, true);
		client.sendKey(ks, false);
		await sleep(8);
	}
	await sleep(100);

	// Press Enter
	client.sendKey(keysym('Return'), true);
	client.sendKey(keysym('Return'), false);

	// Wait for the command to execute
	await sleep(3000);

	// Read clipboard
	const base64Content = client.getClipboard();

	if (!base64Content) {
		return {
			content: [
				{
					type: 'text',
					text: `File download command sent for ${args.remotePath}. Clipboard is empty — the command may still be executing. Try clipboard_read after a few seconds.`,
				},
			],
		};
	}

	return {
		content: [
			{
				type: 'text',
				text: `Base64 content of ${args.remotePath} (${base64Content.length} chars):\n${base64Content}`,
			},
		],
	};
}
