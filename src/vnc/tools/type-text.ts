import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveKeysym } from '../protocol/keysym-map.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface TypeTextArgs {
	text: string;
	delay_ms?: number;
	session_id?: string;
}

const SHIFT_L_KEYSYM = 0xffe1;

// Characters that require the Shift modifier on a standard US ANSI layout.
// Without the bracketed Shift_L press/release, VNC servers translating
// keysym → physical-key map the bare key (e.g. `!` → `1` on US layouts).
//
// EXCLUSIONS — `~ | " @ #` are deliberately omitted. These five sit on
// different physical keys between US and UK ANSI; bracketing them with
// Shift_L causes the US/UK swap (`~`↔`|`, `"`↔`@`) when the VM keymap
// disagrees with the host. Sending the bare keysym lets the RFB server
// resolve the keysym semantically and produce the right glyph.
const SHIFTED_ASCII_REGEX = /[A-Z!$%^&*()_+{}:<>?]/;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleTypeText(
	args: TypeTextArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const delay = args.delay_ms ?? 12;

	for (const char of args.text) {
		const keysym = resolveKeysym(char);
		const needsShift = SHIFTED_ASCII_REGEX.test(char);

		if (needsShift) {
			client.sendKey(SHIFT_L_KEYSYM, true);
		}
		client.sendKey(keysym, true);
		client.sendKey(keysym, false);
		if (needsShift) {
			client.sendKey(SHIFT_L_KEYSYM, false);
		}

		if (delay > 0) {
			await sleep(delay);
		}
	}

	return {
		content: [{ type: 'text', text: `Typed ${args.text.length} characters` }],
	};
}
