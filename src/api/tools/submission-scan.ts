import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionScanTools(server: McpServer): void {
	// --- tz_submission_static_scan ---
	server.tool(
		'tz_submission_static_scan',
		'Static analysis scan results per artifact: PE info, embedded strings, sections, imports/exports, signatures.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/static-scan`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_cdr ---
	server.tool(
		'tz_submission_cdr',
		'CDR (Content Disarm & Reconstruction) analysis metadata: threat level, disarmed element counts, per-element details. To download the sanitized CDR output FILE use tz_download_cdr instead (Task 10).',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/cdr`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_signature_check ---
	server.tool(
		'tz_submission_signature_check',
		'Code-signing signature verification per artifact: signer info, certificate chain, validity, and trust level.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/signature-check`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
