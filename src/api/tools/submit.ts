import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult, BadRequestError } from '../errors.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB

interface FileSource {
	file_path?: string;
	file_base64?: string;
	filename?: string;
}

function expandTilde(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

async function loadFileForUpload(args: FileSource): Promise<{ bytes: Buffer; filename: string }> {
	const hasPath = Boolean(args.file_path);
	const hasB64 = Boolean(args.file_base64);
	if (hasPath === hasB64) {
		throw new BadRequestError(
			'Provide exactly one of file_path (preferred) or file_base64',
			'INVALID_FILE_SOURCE',
		);
	}

	if (hasPath) {
		const resolved = path.resolve(expandTilde(args.file_path as string));
		let stat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			throw new BadRequestError(
				`Cannot read file: ${resolved} (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
				'FILE_NOT_READABLE',
			);
		}
		if (!stat.isFile()) {
			throw new BadRequestError(`Not a regular file: ${resolved}`, 'NOT_A_FILE');
		}
		if (stat.size > MAX_UPLOAD_BYTES) {
			throw new BadRequestError(
				`File too large: ${stat.size} bytes (max ${MAX_UPLOAD_BYTES})`,
				'FILE_TOO_LARGE',
			);
		}
		const bytes = await fs.readFile(resolved);
		const filename = args.filename ?? path.basename(resolved);
		return { bytes, filename };
	}

	if (!args.filename) {
		throw new BadRequestError('filename is required when using file_base64', 'FILENAME_REQUIRED');
	}
	const bytes = Buffer.from(args.file_base64 as string, 'base64');
	return { bytes, filename: args.filename };
}

const fileSourceSchema = {
	file_path: z
		.string()
		.optional()
		.describe(
			'Absolute path (or ~/relative) to a file on the MCP server host. Preferred over file_base64 — avoids tool-call argument size limits. Exactly one of file_path or file_base64 must be set.',
		),
	file_base64: z
		.string()
		.optional()
		.describe(
			'Base64-encoded file content. Use only for small files (<~30 KB) or when file_path is unavailable. Larger payloads will time out the tool channel — use file_path instead.',
		),
	filename: z
		.string()
		.optional()
		.describe(
			'Original filename including extension. Required when using file_base64; inferred from file_path if omitted.',
		),
};

export function registerSubmitTools(server: McpServer): void {
	// --- tz_submit_sandbox ---
	server.tool(
		'tz_submit_sandbox',
		'Create a sandbox analysis submission (full static + dynamic). Consumes one daily submission slot from your plan. Returns the submission UUID and message — call tz_submission_get with the UUID to poll status.',
		{
			...fileSourceSchema,
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
				const { bytes, filename } = await loadFileForUpload(args);
				const formData = new FormData();
				formData.append('file', new Blob([bytes]), filename);
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
			...fileSourceSchema,
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
				const { bytes, filename } = await loadFileForUpload(args);
				const formData = new FormData();
				formData.append('file', new Blob([bytes]), filename);
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
			...fileSourceSchema,
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
				const { bytes, filename } = await loadFileForUpload(args);
				const formData = new FormData();
				formData.append('file', new Blob([bytes]), filename);
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
