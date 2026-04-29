import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionDynamicTools(server: McpServer): void {
	// --- tz_submission_processes ---
	server.tool(
		'tz_submission_processes',
		'Flat process list captured during dynamic analysis: PID, parent PID, image path, command line, lifetime.',
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
					path: `/submissions/${args.uuid}/processes`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_process_tree ---
	server.tool(
		'tz_submission_process_tree',
		'Process spawn tree (parent–child relationships) captured during dynamic analysis.',
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
					path: `/submissions/${args.uuid}/processes/tree`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_behaviours ---
	server.tool(
		'tz_submission_behaviours',
		'Behaviour events captured during dynamic analysis (file/registry/network/process/mutex). Paginated — does NOT auto-paginate.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('1-based page (default 1)'),
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					'Items per page (default 100). The API has no explicit max — large pages are OK.',
				),
			pid: z.number().int().optional().describe('Filter by process ID'),
			operation: z.string().optional().describe('Filter by operation name (e.g. WriteFile)'),
			type: z
				.string()
				.optional()
				.describe('Filter by event type (free-form: registry, file, network, process, mutex, …)'),
			processName: z.string().optional().describe('Filter by process name (exact match)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/behaviours`,
					query: {
						page: args.page,
						limit: args.limit,
						pid: args.pid,
						operation: args.operation,
						type: args.type,
						processName: args.processName,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submission_syscalls ---
	server.tool(
		'tz_submission_syscalls',
		'Raw syscall trace from dynamic analysis. Paginated with default `limit=500` — does NOT auto-paginate.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			page: z.number().int().min(1).optional().describe('1-based page (default 1)'),
			limit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe('Items per page (default 500). Large per-page sizes are typical.'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/syscalls`,
					query: {
						page: args.page,
						limit: args.limit,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
