import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceButton } from '../../shared/remote-session.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface DeviceButtonArgs {
	button: DeviceButton;
	session_id?: string;
}

export function handleDeviceButton(
	args: DeviceButtonArgs,
	sessionManager: SessionManager,
): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	client.sendDeviceButton(args.button);
	return {
		content: [{ type: 'text', text: `Pressed device button: ${args.button}` }],
	};
}
