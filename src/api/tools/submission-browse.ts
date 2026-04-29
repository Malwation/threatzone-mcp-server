import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionBrowseTools(server: McpServer): void {
	// --- tz_submissions_list ---
	server.tool(
		'tz_submissions_list',
		'List submissions in your workspace with rich filtering. Returns paginated `{ items, total, page, limit, totalPages }`. Does NOT auto-paginate — call again with `page: N` to retrieve subsequent pages. Common filters: level (threat verdict), type (file/url), sha256, filename (partial), date range, private flag, tags.',
		{
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('Page number (1-based, default 1)'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Items per page (max 100, default 20)'),
			level: z
				.array(z.enum(['unknown', 'benign', 'suspicious', 'malicious']))
				.optional()
				.describe('Filter by threat level (can specify multiple)'),
			type: z.enum(['file', 'url']).optional().describe('Filter by submission type'),
			sha256: z.string().optional().describe('Search by SHA256 hash (exact or prefix match)'),
			filename: z.string().optional().describe('Partial filename match (case-insensitive)'),
			startDate: z
				.string()
				.optional()
				.describe('ISO 8601 start date filter (createdAt >= startDate)'),
			endDate: z.string().optional().describe('ISO 8601 end date filter (createdAt <= endDate)'),
			private: z.boolean().optional().describe('true = private only, false = public only'),
			tags: z
				.array(z.string())
				.optional()
				.describe('Filter by tags (submissions matching any tag)'),
			sort: z.enum(['createdAt']).optional().describe('Sort field (default createdAt)'),
			order: z.enum(['asc', 'desc']).optional().describe('Sort direction (default desc)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: '/submissions',
					query: {
						page: args.page,
						limit: args.limit,
						level: args.level,
						type: args.type,
						sha256: args.sha256,
						filename: args.filename,
						startDate: args.startDate,
						endDate: args.endDate,
						private: args.private,
						tags: args.tags,
						sort: args.sort,
						order: args.order,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_get ---
	server.tool(
		'tz_submission_get',
		'Get full submission detail by UUID: file metadata, hashes, verdict level, all attached reports (dynamic/static/cdr/url_analysis) with status + score, indicator rollup, and matched MITRE ATT&CK techniques. Returns SubmissionInfoDto.',
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
					path: `/submissions/${args.uuid}`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_search_sha256 ---
	server.tool(
		'tz_submission_search_sha256',
		'Find submissions matching the exact SHA256 hash (across your workspace + public submissions from other workspaces), in reverse creation order. Returns `SubmissionInfoDto[]` (flat array — this endpoint does NOT paginate).',
		{
			sha256: z.string().length(64).describe('SHA256 hex hash (64 characters)'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/search/sha256/${args.sha256}`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
