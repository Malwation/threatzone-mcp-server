import { writeFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type ZodRawShape, z } from 'zod';
import type { ToolContext } from '../../shared/tool-context.js';
import { apiRequest, type BinaryResponse, type OversizeBinaryResponse } from '../client.js';
import { apiErrorResult } from '../errors.js';

const BINARY_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB

const HTTP_LARGE_FILE_NOTE =
	'Returns base64 for files up to 25 MB. For a larger file it returns the Public API download URL and a curl command that fetches it with your Threat.Zone API token.';

const saveToSchema = z
	.string()
	.optional()
	.describe(
		'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
	);

/**
 * Adds `save_to` to a download tool schema in stdio mode only. In HTTP mode the argument is not in
 * the schema, so the model never sees it and the SDK strips it from incoming calls.
 */
function downloadShape<T extends ZodRawShape>(
	ctx: ToolContext,
	shape: T,
): T & { save_to: typeof saveToSchema } {
	if (ctx.transportMode === 'stdio') return { ...shape, save_to: saveToSchema };
	return shape as T & { save_to: typeof saveToSchema };
}

function byMode(ctx: ToolContext, stdio: string, http: string): string {
	return ctx.transportMode === 'stdio' ? stdio : http;
}

// Header looks like: attachment; filename="malware.exe" or filename=foo.bin
function parseFilename(contentDisposition: string | undefined): string | undefined {
	return contentDisposition
		? /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
				.exec(contentDisposition)?.[1]
				?.replace(/^['"]|['"]$/g, '')
		: undefined;
}

function inlineResult(resp: BinaryResponse): CallToolResult {
	const filename = parseFilename(resp.contentDisposition);
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify(
					{
						data: resp.buffer.toString('base64'),
						mimetype: resp.contentType,
						filename: filename ?? null,
						size: resp.buffer.byteLength,
					},
					null,
					2,
				),
			},
		],
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function oversizeResult(resp: OversizeBinaryResponse, fallbackFilename: string): CallToolResult {
	const rawName = parseFilename(resp.contentDisposition) || fallbackFilename;
	// The name only feeds the example curl command: keep it a plain file name in the working directory.
	const filename = rawName.replace(/[^\w.-]/g, '_');
	const sizeText =
		resp.size === undefined
			? 'over the 25 MB inline cap'
			: `${(resp.size / 1024 / 1024).toFixed(1)} MB, over the 25 MB inline cap`;
	const text = [
		`File too large to return inline (${sizeText}). Download it directly from the Threat.Zone Public API.`,
		'',
		'Method: GET',
		`URL: ${resp.url}`,
		'',
		'Fetch it with the same Threat.Zone API token you use for this MCP server, sent as the header `Authorization: Bearer <your API token>`.',
		'',
		`curl -H "Authorization: Bearer <YOUR_API_TOKEN>" -o ${shellQuote(filename)} ${shellQuote(resp.url)}`,
	].join('\n');
	return { content: [{ type: 'text', text }] };
}

export interface BinaryDownloadOptions {
	/** Public API path, for example `/submissions/{uuid}/download/pcap`. */
	path: string;
	apiToken: string | undefined;
	/** stdio mode only. HTTP mode never reads this value. */
	saveTo?: string | undefined;
	/** File name for the HTTP-mode curl command when the API sends no Content-Disposition. */
	fallbackFilename: string;
	/** HTTP mode only: return an inline file as an MCP `image` content block instead of base64 text. */
	asImage?: boolean;
}

/**
 * Shared helper for all binary download tools.
 *
 * stdio mode:
 * - Default behaviour: returns base64 + mimetype + filename + size in CallToolResult.
 * - 25 MB cap: if buffer exceeds, return an isError result instructing the LLM to use save_to.
 * - save_to path: writes the buffer to disk via fs/promises.writeFile, returns metadata only (no base64 payload).
 *
 * HTTP mode never touches the server disk:
 * - Files up to 25 MB: same inline result as stdio (or an `image` block when `asImage` is set).
 * - Larger files: the body is not read. Returns the Public API URL, the token instruction and a
 *   curl command with a token placeholder.
 */
export async function handleBinaryDownload(
	ctx: ToolContext,
	opts: BinaryDownloadOptions,
): Promise<CallToolResult> {
	if (ctx.transportMode === 'http') {
		const resp = await apiRequest({
			path: opts.path,
			binary: true,
			apiToken: opts.apiToken,
			maxBytes: BINARY_SIZE_LIMIT,
		});
		if ('oversize' in resp) return oversizeResult(resp, opts.fallbackFilename);
		if (opts.asImage) {
			const mimeType = resp.contentType.startsWith('image/')
				? resp.contentType.split(';')[0].trim()
				: 'image/png';
			return { content: [{ type: 'image', data: resp.buffer.toString('base64'), mimeType }] };
		}
		return inlineResult(resp);
	}

	const saveTo = opts.saveTo;
	const resp = await apiRequest({ path: opts.path, binary: true, apiToken: opts.apiToken });

	if (resp.buffer.byteLength > BINARY_SIZE_LIMIT && !saveTo) {
		return {
			content: [
				{
					type: 'text',
					text: `File too large (${(resp.buffer.byteLength / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB inline cap). Pass the save_to argument with an absolute filesystem path to write the file to disk instead.`,
				},
			],
			isError: true,
		};
	}

	if (saveTo) {
		await writeFile(saveTo, resp.buffer);
		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(
						{
							saved: true,
							path: saveTo,
							size: resp.buffer.byteLength,
							mimetype: resp.contentType,
						},
						null,
						2,
					),
				},
			],
		};
	}

	return inlineResult(resp);
}

const apiTokenSchema = z
	.string()
	.optional()
	.describe('Override THREATZONE_API_TOKEN env var for this call');

export function registerDownloadTools(server: McpServer, ctx: ToolContext): void {
	// --- tz_download_sample ---
	server.tool(
		'tz_download_sample',
		byMode(
			ctx,
			'Download the original submission sample as a password-protected ZIP. The ZIP password is `infected` (industry standard for malware sandboxing). Returns base64 for files up to 25 MB; pass save_to with an absolute path for larger files.',
			`Download the original submission sample as a password-protected ZIP. The ZIP password is \`infected\` (industry standard for malware sandboxing). ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/sample`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}.zip`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_artifact ---
	server.tool(
		'tz_download_artifact',
		byMode(
			ctx,
			'Download a specific artifact (dropped file, memory dump, etc.) by its MongoDB ObjectId. Get the artifact_id from tz_submission_artifacts. Returns base64 for files up to 25 MB; pass save_to for larger files.',
			`Download a specific artifact (dropped file, memory dump, etc.) by its MongoDB ObjectId. Get the artifact_id from tz_submission_artifacts. ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			artifact_id: z.string().describe('Artifact ObjectId from tz_submission_artifacts'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/artifact/${args.artifact_id}`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.artifact_id}.bin`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_pcap ---
	server.tool(
		'tz_download_pcap',
		byMode(
			ctx,
			'Download the network packet capture (PCAP) from dynamic analysis. PCAPs can be very large for long analyses — recommend passing save_to with an absolute path.',
			`Download the network packet capture (PCAP) from dynamic analysis. PCAPs can be very large for long analyses. ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/pcap`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}.pcap`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_yara_rule ---
	server.tool(
		'tz_download_yara_rule',
		'Download the auto-generated YARA rule file produced from the analysis. Small text payload — typically returned inline as base64.',
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/yara-rule`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}.yar`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_html_report ---
	server.tool(
		'tz_download_html_report',
		byMode(
			ctx,
			'Download the full HTML analysis report (rendered, ready to share). Useful for archival or human review.',
			`Download the full HTML analysis report (rendered, ready to share). Useful for archival or human review. ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/html-report`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}.html`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_cdr ---
	server.tool(
		'tz_download_cdr',
		byMode(
			ctx,
			'Download the CDR (Content Disarm & Reconstruction) sanitized output file — the reconstructed safe version of the input document. To get the CDR analysis metadata report (threat level, disarmed elements), use tz_submission_cdr instead.',
			`Download the CDR (Content Disarm & Reconstruction) sanitized output file — the reconstructed safe version of the input document. To get the CDR analysis metadata report (threat level, disarmed elements), use tz_submission_cdr instead. ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/download/cdr`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}-cdr.bin`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_screenshot ---
	// Path is /submissions/{uuid}/screenshot — NOT under /download/
	server.tool(
		'tz_download_screenshot',
		byMode(
			ctx,
			'Download the URL analysis screenshot as PNG. Returns 409 URL_ANALYSIS_REPORT_UNAVAILABLE for non-URL submissions. For sandbox/open-in-browser media (multiple screenshots/videos), use tz_download_media instead.',
			'Download the URL analysis screenshot as PNG, returned inline as an image. Returns 409 URL_ANALYSIS_REPORT_UNAVAILABLE for non-URL submissions. For sandbox/open-in-browser media (multiple screenshots/videos), use tz_download_media instead.',
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/screenshot`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.uuid}.png`,
					asImage: true,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_media ---
	server.tool(
		'tz_download_media',
		byMode(
			ctx,
			'Download a specific media file (screenshot or video clip) captured during dynamic analysis by its file_id. Get the file_id from tz_submission_media_list. Returns base64 for files up to 25 MB; pass save_to for larger files.',
			`Download a specific media file (screenshot or video clip) captured during dynamic analysis by its file_id. Get the file_id from tz_submission_media_list. ${HTTP_LARGE_FILE_NOTE}`,
		),
		downloadShape(ctx, {
			uuid: z.string().describe('Submission UUID'),
			file_id: z.string().describe('Media file ID from tz_submission_media_list'),
			api_token: apiTokenSchema,
		}),
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(ctx, {
					path: `/submissions/${args.uuid}/media/${args.file_id}`,
					apiToken: args.api_token,
					saveTo: args.save_to,
					fallbackFilename: `${args.file_id}.bin`,
				});
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
