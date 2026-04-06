import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveKeysym } from '../protocol/keysym-map.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface TypeTextArgs {
	text: string;
	delay_ms?: number;
	session_id?: string;
}

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
		client.sendKey(keysym, true);
		client.sendKey(keysym, false);
		if (delay > 0) {
			await sleep(delay);
		}
	}

	return {
		content: [{ type: 'text', text: `Typed ${args.text.length} characters` }],
	};
}
