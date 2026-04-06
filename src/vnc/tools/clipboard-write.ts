import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface ClipboardWriteArgs {
	text: string;
	session_id?: string;
}

export function handleClipboardWrite(
	args: ClipboardWriteArgs,
	sessionManager: SessionManager,
): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	client.updateClipboard(args.text);
	return {
		content: [{ type: 'text', text: `Sent ${args.text.length} characters to remote clipboard` }],
	};
}
