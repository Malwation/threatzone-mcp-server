import { Buffer } from 'node:buffer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { isSubmitAllowed } from '../config.js';
import { apiErrorResult } from '../errors.js';

export function registerSubmitTools(server: McpServer): void {
	if (!isSubmitAllowed()) {
		console.error('[api] submit tools disabled (THREATZONE_ALLOW_SUBMIT != "true")');
		return;
	}
	console.error('[api] submit tools ENABLED — write surface active');

	// --- tz_submit_sandbox ---
	server.tool(
		'tz_submit_sandbox',
		'Create a sandbox analysis submission (full static + dynamic). Consumes one daily submission slot from your plan. Returns the submission UUID and message — call tz_submission_get with the UUID to poll status.',
		{
			file_base64: z
				.string()
				.describe('Base64-encoded file content (entire file as a single base64 string)'),
			filename: z.string().describe('Original filename including extension (e.g. sample.exe)'),
			api_token: z.string().optional(),
			environment: z
				.string()
				.optional()
				.describe(
					'Sandbox OS environment key (e.g. w10_x64). Use tz_config_environments to discover available keys.',
				),
			metafields: z
				.record(z.unknown())
				.optional()
				.describe('Plan-dependent key/value pairs. Use tz_config_metafields_sandbox to discover.'),
			private: z
				.boolean()
				.optional()
				.describe('Make submission visible only to your workspace (default false)'),
			entrypoint: z
				.string()
				.optional()
				.describe(
					'For archive files: path inside the archive to execute (e.g. "malware.exe", "folder/script.js")',
				),
			password: z.string().optional().describe('Password for encrypted/protected archives'),
			configurations: z
				.object({
					preScript: z.string().optional(),
					startArguments: z.string().optional(),
					networkConfig: z
						.string()
						.optional()
						.describe('MongoDB ObjectId of a network config from tz_network_configs_list'),
				})
				.optional()
				.describe('Advanced execution configuration (plan-dependent)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const formData = new FormData();
				const bytes = Buffer.from(args.file_base64, 'base64');
				formData.append('file', new Blob([bytes]), args.filename);
				if (args.environment) formData.append('environment', args.environment);
				if (args.metafields) formData.append('metafields', JSON.stringify(args.metafields));
				if (args.private !== undefined) formData.append('private', String(args.private));
				if (args.entrypoint) formData.append('entrypoint', args.entrypoint);
				if (args.password) formData.append('password', args.password);
				if (args.configurations)
					formData.append('configurations', JSON.stringify(args.configurations));

				const data = await apiRequest({
					path: '/submissions/sandbox',
					method: 'POST',
					body: formData,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submit_static ---
	server.tool(
		'tz_submit_static',
		'Create a static-only analysis submission. Faster than sandbox (no dynamic execution). Returns the submission UUID and message — poll with tz_submission_get.',
		{
			file_base64: z
				.string()
				.describe('Base64-encoded file content (entire file as a single base64 string)'),
			filename: z.string().describe('Original filename including extension (e.g. sample.exe)'),
			api_token: z.string().optional(),
			private: z
				.boolean()
				.optional()
				.describe('Make submission visible only to your workspace (default false)'),
			entrypoint: z
				.string()
				.optional()
				.describe(
					'For archive files: path inside the archive to execute (e.g. "malware.exe", "folder/script.js")',
				),
			password: z.string().optional().describe('Password for encrypted/protected archives'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const formData = new FormData();
				const bytes = Buffer.from(args.file_base64, 'base64');
				formData.append('file', new Blob([bytes]), args.filename);
				if (args.private !== undefined) formData.append('private', String(args.private));
				if (args.entrypoint) formData.append('entrypoint', args.entrypoint);
				if (args.password) formData.append('password', args.password);

				const data = await apiRequest({
					path: '/submissions/static',
					method: 'POST',
					body: formData,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submit_cdr ---
	server.tool(
		'tz_submit_cdr',
		'Create a CDR (Content Disarm & Reconstruction) submission. The output is a sanitized version of the input document with active content removed. Returns the submission UUID — poll with tz_submission_get and download the sanitized file via tz_download_cdr.',
		{
			file_base64: z
				.string()
				.describe('Base64-encoded file content (entire file as a single base64 string)'),
			filename: z.string().describe('Original filename including extension (e.g. sample.exe)'),
			api_token: z.string().optional(),
			private: z
				.boolean()
				.optional()
				.describe('Make submission visible only to your workspace (default false)'),
			entrypoint: z
				.string()
				.optional()
				.describe('For archive files: path inside the archive to extract and process'),
			password: z.string().optional().describe('Password for encrypted/protected archives'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const formData = new FormData();
				const bytes = Buffer.from(args.file_base64, 'base64');
				formData.append('file', new Blob([bytes]), args.filename);
				if (args.private !== undefined) formData.append('private', String(args.private));
				if (args.entrypoint) formData.append('entrypoint', args.entrypoint);
				if (args.password) formData.append('password', args.password);

				const data = await apiRequest({
					path: '/submissions/cdr',
					method: 'POST',
					body: formData,
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submit_url ---
	server.tool(
		'tz_submit_url',
		'Create a URL analysis submission. The crawler fetches the URL, captures screenshot, follows redirects, checks certs and threat lists. Only submit URLs you have authorisation to analyse.',
		{
			url: z
				.string()
				.url()
				.describe(
					'Absolute URL to analyse (HTTP/HTTPS). Shortened URLs are auto-expanded and followed.',
				),
			api_token: z.string().optional(),
			private: z
				.boolean()
				.optional()
				.describe('Make submission visible only to your workspace (default false)'),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: '/submissions/url_analysis',
					method: 'POST',
					body: { url: args.url, private: args.private },
					apiToken: args.api_token,
				});
				return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_submit_open_in_browser ---
	server.tool(
		'tz_submit_open_in_browser',
		'Create an "open in browser" submission. The URL becomes the entrypoint for a sandboxed browser session — useful for credential-harvesting kits and exploit pages. Returns the submission UUID — poll with tz_submission_get.',
		{
			url: z.string().url().describe('Absolute URL to open inside the sandboxed browser'),
			api_token: z.string().optional(),
			environment: z.string().optional(),
			metafields: z.record(z.unknown()).optional(),
			private: z
				.boolean()
				.optional()
				.describe('Make submission visible only to your workspace (default false)'),
			configurations: z
				.object({
					preScript: z.string().optional(),
					startArguments: z.string().optional(),
					networkConfig: z.string().optional(),
				})
				.optional(),
		},
		async (args): Promise<CallToolResult> => {
			try {
				const data = await apiRequest({
					path: '/submissions/open_in_browser',
					method: 'POST',
					body: {
						url: args.url,
						private: args.private,
						environment: args.environment,
						metafields: args.metafields,
						configurations: args.configurations,
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
