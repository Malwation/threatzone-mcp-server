import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

const BINARY_SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB

/**
 * Shared helper for all binary download tools. Used by tz_download_* tools and tz_download_media (Task 11).
 * - Default behaviour: returns base64 + mimetype + filename + size in CallToolResult.
 * - 25 MB cap: if buffer exceeds, return an isError result instructing the LLM to use save_to.
 * - save_to path: writes the buffer to disk via fs/promises.writeFile, returns metadata only (no base64 payload).
 */
export async function handleBinaryDownload(
	path: string,
	apiToken: string | undefined,
	saveTo: string | undefined,
): Promise<CallToolResult> {
	const resp = await apiRequest({ path, binary: true, apiToken });

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
		const { writeFile } = await import('node:fs/promises');
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

	// Extract filename from Content-Disposition header if present.
	// Header looks like: attachment; filename="malware.exe" or filename=foo.bin
	const filename = resp.contentDisposition
		? /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/
				.exec(resp.contentDisposition)?.[1]
				?.replace(/^['"]|['"]$/g, '')
		: undefined;

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

export function registerDownloadTools(server: McpServer): void {
	// --- tz_download_sample ---
	server.tool(
		'tz_download_sample',
		'Download the original submission sample as a password-protected ZIP. The ZIP password is `infected` (industry standard for malware sandboxing). Returns base64 for files up to 25 MB; pass save_to with an absolute path for larger files.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/sample`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_artifact ---
	server.tool(
		'tz_download_artifact',
		'Download a specific artifact (dropped file, memory dump, etc.) by its MongoDB ObjectId. Get the artifact_id from tz_submission_artifacts. Returns base64 for files up to 25 MB; pass save_to for larger files.',
		{
			uuid: z.string().describe('Submission UUID'),
			artifact_id: z.string().describe('Artifact ObjectId from tz_submission_artifacts'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/artifact/${args.artifact_id}`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_pcap ---
	server.tool(
		'tz_download_pcap',
		'Download the network packet capture (PCAP) from dynamic analysis. PCAPs can be very large for long analyses — recommend passing save_to with an absolute path.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/pcap`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_yara_rule ---
	server.tool(
		'tz_download_yara_rule',
		'Download the auto-generated YARA rule file produced from the analysis. Small text payload — typically returned inline as base64.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/yara-rule`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_html_report ---
	server.tool(
		'tz_download_html_report',
		'Download the full HTML analysis report (rendered, ready to share). Useful for archival or human review.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/html-report`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_cdr ---
	server.tool(
		'tz_download_cdr',
		'Download the CDR (Content Disarm & Reconstruction) sanitized output file — the reconstructed safe version of the input document. To get the CDR analysis metadata report (threat level, disarmed elements), use tz_submission_cdr instead.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/download/cdr`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_screenshot ---
	// Path is /submissions/{uuid}/screenshot — NOT under /download/
	server.tool(
		'tz_download_screenshot',
		'Download the URL analysis screenshot as PNG. Returns 409 URL_ANALYSIS_REPORT_UNAVAILABLE for non-URL submissions. For sandbox/open-in-browser media (multiple screenshots/videos), use tz_download_media instead.',
		{
			uuid: z.string().describe('Submission UUID'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/screenshot`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);

	// --- tz_download_media (Task 11) ---
	server.tool(
		'tz_download_media',
		'Download a specific media file (screenshot or video clip) captured during dynamic analysis by its file_id. Get the file_id from tz_submission_media_list. Returns base64 for files up to 25 MB; pass save_to for larger files.',
		{
			uuid: z.string().describe('Submission UUID'),
			file_id: z.string().describe('Media file ID from tz_submission_media_list'),
			api_token: z
				.string()
				.optional()
				.describe('Override THREATZONE_API_TOKEN env var for this call'),
			save_to: z
				.string()
				.optional()
				.describe(
					'Absolute filesystem path to write the file to disk; if omitted returns base64 (max 25 MB)',
				),
		},
		async (args): Promise<CallToolResult> => {
			try {
				return await handleBinaryDownload(
					`/submissions/${args.uuid}/media/${args.file_id}`,
					args.api_token,
					args.save_to,
				);
			} catch (err) {
				return apiErrorResult(err);
			}
		},
	);
}
