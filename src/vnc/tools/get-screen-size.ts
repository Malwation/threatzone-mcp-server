import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface GetScreenSizeArgs {
	session_id?: string;
}

export function handleGetScreenSize(
	args: GetScreenSizeArgs,
	sessionManager: SessionManager,
): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	const size = client.screenSize;

	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({ width: size?.width ?? 0, height: size?.height ?? 0 }),
			},
		],
	};
}
