import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { apiRequest } from '../client.js';
import { apiErrorResult } from '../errors.js';

const schema = {
	api_token: z.string().optional().describe('Override THREATZONE_API_TOKEN env var for this call'),
};

function makeReadOnlyHandler(path: string) {
	return async (args: { api_token?: string }): Promise<CallToolResult> => {
		try {
			const data = await apiRequest({ path, apiToken: args.api_token });
			return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
		} catch (err) {
			return apiErrorResult(err);
		}
	};
}

export function registerConfigTools(server: McpServer): void {
	server.tool(
		'tz_config_metafields',
		'All available metafield options across all submission types',
		schema,
		makeReadOnlyHandler('/config/metafields'),
	);

	server.tool(
		'tz_config_metafields_sandbox',
		'Sandbox-specific metafield options',
		schema,
		makeReadOnlyHandler('/config/metafields/sandbox'),
	);

	server.tool(
		'tz_config_metafields_static',
		'Static analysis metafield options',
		schema,
		makeReadOnlyHandler('/config/metafields/static'),
	);

	server.tool(
		'tz_config_metafields_cdr',
		'CDR metafield options',
		schema,
		makeReadOnlyHandler('/config/metafields/cdr'),
	);

	server.tool(
		'tz_config_metafields_url',
		'URL analysis metafield options',
		schema,
		makeReadOnlyHandler('/config/metafields/url'),
	);

	server.tool(
		'tz_config_metafields_open_in_browser',
		'Open-in-browser metafield options',
		schema,
		makeReadOnlyHandler('/config/metafields/open_in_browser'),
	);

	server.tool(
		'tz_config_environments',
		'Available sandbox OS environments and their feature flags',
		schema,
		makeReadOnlyHandler('/config/environments'),
	);

	server.tool(
		'tz_network_configs_list',
		'Workspace network configurations (proxy/VPN profiles); use the returned ObjectId in tz_submit_sandbox/tz_submit_open_in_browser configurations.networkConfig',
		schema,
		makeReadOnlyHandler('/v1/network-configs'),
	);
}
