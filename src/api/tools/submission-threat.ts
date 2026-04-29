import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionThreatTools(server: McpServer): void {
	// --- tz_submission_mitre ---
	server.tool(
		'tz_submission_mitre',
		'MITRE ATT&CK technique mappings observed during dynamic analysis. Returns an empty techniques array if none mapped.',
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
					path: `/submissions/${args.uuid}/mitre`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_extracted_configs ---
	server.tool(
		'tz_submission_extracted_configs',
		'Extracted malware configuration data (C2 endpoints, encryption keys, family-specific config) parsed by family-aware extractors.',
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
					path: `/submissions/${args.uuid}/extracted-configs`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_eml_analysis ---
	server.tool(
		'tz_submission_eml_analysis',
		'EML/MSG email analysis results: headers, attachments, embedded URLs, sender reputation. Returns 409 DYNAMIC_REPORT_UNAVAILABLE for non-email submissions.',
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
					path: `/submissions/${args.uuid}/eml-analysis`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
