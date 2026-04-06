import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface FileUploadArgs {
	localBase64: string;
	remotePath: string;
	os?: 'windows' | 'linux';
	session_id?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleFileUpload(
	args: FileUploadArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const os = args.os ?? 'windows';
	const base64 = args.localBase64;

	// Write the entire base64 content to clipboard
	client.updateClipboard(base64);
	await sleep(200);

	if (os === 'windows') {
		// Open Run dialog, launch PowerShell to decode clipboard to file
		const cmd =
			`powershell -Command "[IO.File]::WriteAllBytes('${args.remotePath}', ` +
			`[Convert]::FromBase64String((Get-Clipboard -Raw)))"`;

		// Type the command via send_key (Win+R → type → Enter)
		const keysym = (await import('../protocol/keysym-map.js')).resolveKeysym;

		// Win+R to open Run
		client.sendKey(keysym('super_l'), true);
		client.sendKey(keysym('r'), true);
		client.sendKey(keysym('r'), false);
		client.sendKey(keysym('super_l'), false);
		await sleep(500);

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
	} else {
		// Linux: write clipboard via xclip decode
		const cmd = `echo "$(xclip -o -selection clipboard)" | base64 -d > "${args.remotePath}"`;

		const keysym = (await import('../protocol/keysym-map.js')).resolveKeysym;

		// Ctrl+Alt+T for terminal
		client.sendKey(keysym('Control_L'), true);
		client.sendKey(keysym('Alt_L'), true);
		client.sendKey(keysym('t'), true);
		client.sendKey(keysym('t'), false);
		client.sendKey(keysym('Alt_L'), false);
		client.sendKey(keysym('Control_L'), false);
		await sleep(1000);

		for (const char of cmd) {
			const ks = keysym(char);
			client.sendKey(ks, true);
			client.sendKey(ks, false);
			await sleep(8);
		}
		await sleep(100);

		client.sendKey(keysym('Return'), true);
		client.sendKey(keysym('Return'), false);
	}

	return {
		content: [
			{
				type: 'text',
				text: `File upload initiated to ${args.remotePath} (${Math.round(base64.length * 0.75)} bytes). Check remote machine for completion.`,
			},
		],
	};
}
