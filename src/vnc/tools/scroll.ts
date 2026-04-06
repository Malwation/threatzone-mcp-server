import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SCROLL_DIRECTION_MASK } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface ScrollArgs {
	x: number;
	y: number;
	direction: 'up' | 'down' | 'left' | 'right';
	clicks?: number;
	session_id?: string;
}

export function handleScroll(args: ScrollArgs, sessionManager: SessionManager): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	const mask = SCROLL_DIRECTION_MASK[args.direction];
	const clicks = args.clicks ?? 3;

	for (let i = 0; i < clicks; i++) {
		// Press scroll button
		client.sendPointer(args.x, args.y, mask);
		// Release
		client.sendPointer(args.x, args.y, 0);
	}

	return {
		content: [
			{
				type: 'text',
				text: `Scrolled ${args.direction} ${clicks} clicks at (${args.x}, ${args.y})`,
			},
		],
	};
}
