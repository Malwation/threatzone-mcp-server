import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface DisconnectArgs {
	session_id?: string;
}

export function handleDisconnect(
	args: DisconnectArgs,
	sessionManager: SessionManager,
): CallToolResult {
	sessionManager.disconnect(args.session_id);
	return {
		content: [
			{
				type: 'text',
				text: args.session_id
					? `Disconnected session '${args.session_id}'`
					: 'Disconnected active session',
			},
		],
	};
}
