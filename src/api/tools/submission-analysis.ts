import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionAnalysisTools(server: McpServer): void {
	// --- tz_submission_summary ---
	server.tool(
		'tz_submission_summary',
		'High-level submission verdict rollup: overall analysis status, per-module score and verdict counts, indicator level rollup, and matched MITRE technique count.',
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
					path: `/submissions/${args.uuid}/summary`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_indicators ---
	server.tool(
		'tz_submission_indicators',
		'Behavioural detection indicators from dynamic analysis, paginated. Returns `{ items, total, page, limit, totalPages }` — does NOT auto-paginate.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('1-based page (default 1)'),
			limit: z.number().int().min(1).optional().describe('Items per page (default 20)'),
			level: z
				.enum(['malicious', 'suspicious', 'benign'])
				.optional()
				.describe('Filter by indicator threat level'),
			category: z.string().optional().describe('Filter by category (exact match)'),
			pid: z.number().int().optional().describe('Filter by process ID'),
			attackCode: z
				.string()
				.optional()
				.describe('Filter by MITRE ATT&CK technique code (e.g. T1055)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/indicators`,
					query: {
						page: args.page,
						limit: args.limit,
						level: args.level,
						category: args.category,
						pid: args.pid,
						attackCode: args.attackCode,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_iocs ---
	server.tool(
		'tz_submission_iocs',
		'Indicators of Compromise extracted from analysis: IPs, domains, URLs, hashes, registry keys, file paths, etc. Paginated `{ items, total, page, limit, totalPages }` — does NOT auto-paginate.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('1-based page (default 1)'),
			limit: z.number().int().min(1).optional().describe('Items per page (default 20)'),
			type: z
				.enum([
					'ip',
					'domain',
					'url',
					'email',
					'sha512',
					'sha256',
					'sha1',
					'md5',
					'registry',
					'path',
					'uuid',
				])
				.optional()
				.describe('Filter by IoC type'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/iocs`,
					query: {
						page: args.page,
						limit: args.limit,
						type: args.type,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_yara_rules ---
	server.tool(
		'tz_submission_yara_rules',
		'YARA rule hits during analysis. Paginated — does NOT auto-paginate.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('1-based page (default 1)'),
			limit: z.number().int().min(1).optional().describe('Items per page (default 20)'),
			category: z
				.enum(['malicious', 'suspicious', 'benign'])
				.optional()
				.describe('Filter by YARA rule category'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/yara-rules`,
					query: {
						page: args.page,
						limit: args.limit,
						category: args.category,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_artifacts ---
	server.tool(
		'tz_submission_artifacts',
		'Full artifact list for the submission: original sample, dropped files, memory dumps, PCAPs, generated YARA rules, and CDR-sanitized variants. NOT paginated — single response with all artifacts.',
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
					path: `/submissions/${args.uuid}/artifacts`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
