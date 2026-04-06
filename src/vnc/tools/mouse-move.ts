import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface MouseMoveArgs {
	x: number;
	y: number;
	session_id?: string;
}

export function handleMouseMove(
	args: MouseMoveArgs,
	sessionManager: SessionManager,
): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	client.sendPointer(args.x, args.y, 0);

	return {
		content: [{ type: 'text', text: `Moved mouse to (${args.x}, ${args.y})` }],
	};
}
