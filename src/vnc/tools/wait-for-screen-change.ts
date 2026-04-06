import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Region } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface WaitForScreenChangeArgs {
	timeout_ms?: number;
	region?: Region;
	session_id?: string;
}

export async function handleWaitForScreenChange(
	args: WaitForScreenChangeArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const timeout = args.timeout_ms ?? 5000;

	// Take reference screenshot
	const refImage = await client.screenshot('png', args.region);
	const refHash = createHash('sha256').update(refImage).digest();

	const start = Date.now();

	while (Date.now() - start < timeout) {
		client.requestFramebufferUpdate(true);
		const remaining = timeout - (Date.now() - start);
		const gotRect = await client.waitForRect(Math.min(500, remaining));
		if (!gotRect) continue;

		const newImage = await client.screenshot('png', args.region);
		const newHash = createHash('sha256').update(newImage).digest();

		if (!refHash.equals(newHash)) {
			const elapsed = Date.now() - start;
			return {
				content: [{ type: 'text', text: `Screen changed after ${elapsed}ms` }],
			};
		}
	}

	return {
		content: [{ type: 'text', text: `No screen change detected within ${timeout}ms` }],
	};
}
