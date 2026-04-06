import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ImageFormat, Region } from '../protocol/protocol-types.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface ScreenshotArgs {
	session_id?: string;
	format?: ImageFormat;
	quality?: number;
	region?: Region;
}

export async function handleScreenshot(
	args: ScreenshotArgs,
	sessionManager: SessionManager,
): Promise<CallToolResult> {
	const client = sessionManager.getSession(args.session_id);
	const format = args.format ?? 'png';
	const imageBuffer = await client.screenshot(format, args.region, args.quality);
	const base64 = imageBuffer.toString('base64');
	const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

	return {
		content: [
			{
				type: 'image',
				data: base64,
				mimeType,
			},
		],
	};
}
