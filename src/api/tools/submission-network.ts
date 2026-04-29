import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmissionNetworkTools(server: McpServer): void {
	// --- tz_network_summary ---
	server.tool(
		'tz_network_summary',
		'Network activity summary captured during dynamic analysis: per-protocol counts (DNS, HTTP, TCP, UDP) and threat detection rollup.',
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
					path: `/submissions/${args.uuid}/network/summary`,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_network_dns ---
	server.tool(
		'tz_network_dns',
		'DNS queries observed during dynamic analysis (query, response, type). Uses `limit`/`skip` offset pagination — NOT `page`/`limit`. Pass `skip: N` to advance through results.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			limit: z.number().int().min(1).optional().describe('Maximum results to return'),
			skip: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Number of results to skip (for offset pagination)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/network/dns`,
					query: {
						limit: args.limit,
						skip: args.skip,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_network_http ---
	server.tool(
		'tz_network_http',
		'HTTP request endpoints observed during dynamic analysis (method, URL, status, host). Uses `limit`/`skip` offset pagination — NOT `page`/`limit`. Pass `skip: N` to advance through results.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			limit: z.number().int().min(1).optional().describe('Maximum results to return'),
			skip: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Number of results to skip (for offset pagination)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/network/http`,
					query: {
						limit: args.limit,
						skip: args.skip,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_network_tcp ---
	server.tool(
		'tz_network_tcp',
		'TCP connections observed during dynamic analysis (source IP/port, destination IP/port, byte counts). Uses `limit`/`skip` offset pagination — NOT `page`/`limit`. Pass `skip: N` to advance through results.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			limit: z.number().int().min(1).optional().describe('Maximum results to return'),
			skip: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Number of results to skip (for offset pagination)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/network/tcp`,
					query: {
						limit: args.limit,
						skip: args.skip,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_network_udp ---
	server.tool(
		'tz_network_udp',
		'UDP connections observed during dynamic analysis (source IP/port, destination IP/port, byte counts). Uses `limit`/`skip` offset pagination — NOT `page`/`limit`. Pass `skip: N` to advance through results.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			limit: z.number().int().min(1).optional().describe('Maximum results to return'),
			skip: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Number of results to skip (for offset pagination)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/network/udp`,
					query: {
						limit: args.limit,
						skip: args.skip,
					},
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_network_threats ---
	server.tool(
		'tz_network_threats',
		'Suricata-style network threat detections from dynamic analysis (signature, severity, src/dst). Uses `limit`/`skip` offset pagination — NOT `page`/`limit`. Pass `skip: N` to advance through results.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			limit: z.number().int().min(1).optional().describe('Maximum results to return'),
			skip: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Number of results to skip (for offset pagination)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: `/submissions/${args.uuid}/network/threats`,
					query: {
						limit: args.limit,
						skip: args.skip,
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
