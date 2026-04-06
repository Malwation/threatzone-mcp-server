import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface ClipboardReadArgs {
	session_id?: string;
}

export function handleClipboardRead(
	args: ClipboardReadArgs,
	sessionManager: SessionManager,
): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	const text = client.getClipboard();
	if (text === null) {
		return {
			content: [{ type: 'text', text: 'No clipboard data received from server yet.' }],
		};
	}
	return {
		content: [{ type: 'text', text }],
	};
}
