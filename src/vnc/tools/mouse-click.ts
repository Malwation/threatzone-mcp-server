import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BUTTON_MASK } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

/**
 * Hold the press for ~50ms before releasing. Without this, Android (and
 * touch-emulating gateways) treat the down→up as noise and ignore the tap.
 * Real human taps land in the 50–150ms range; 50ms is the lower bound that
 * still registers reliably on launchers / onboarding buttons.
 */
const TAP_HOLD_MS = 50;

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

	// Click: press, hold, release
	client.sendPointer(args.x, args.y, mask);
	await sleep(TAP_HOLD_MS);
	client.sendPointer(args.x, args.y, 0);

	if (clickType === 'double') {
		await sleep(50);
		client.sendPointer(args.x, args.y, mask);
		await sleep(TAP_HOLD_MS);
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
