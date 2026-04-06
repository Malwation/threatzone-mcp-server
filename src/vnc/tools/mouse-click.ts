import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BUTTON_MASK } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface MouseClickArgs {
	x: number;
	y: number;
	button?: 'left' | 'middle' | 'right';
	click_type?: 'single' | 'double';
	session_id?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleMouseClick(
	args: MouseClickArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const button = args.button ?? 'left';
	const clickType = args.click_type ?? 'single';
	const mask = BUTTON_MASK[button];

	// Move to position
	client.sendPointer(args.x, args.y, 0);

	// Click: press then release
	client.sendPointer(args.x, args.y, mask);
	client.sendPointer(args.x, args.y, 0);

	if (clickType === 'double') {
		await sleep(50);
		client.sendPointer(args.x, args.y, mask);
		client.sendPointer(args.x, args.y, 0);
	}

	return {
		content: [
			{
				type: 'text',
				text: `${clickType === 'double' ? 'Double-clicked' : 'Clicked'} ${button} button at (${args.x}, ${args.y})`,
			},
		],
	};
}
