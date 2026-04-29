import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveKeysym } from '../protocol/keysym-map.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface TypeTextArgs {
	text: string;
	delay_ms?: number;
	session_id?: string;
}

const SHIFT_L_KEYSYM = 0xffe1;

// `~ | " @ #` deliberately excluded — different physical keys on US vs UK,
// so bracketing produces a layout swap (`~`↔`|`, `"`↔`@`).
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
