import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './tools/account.js';
import { registerConfigTools } from './tools/config.js';
import { registerDownloadTools } from './tools/downloads.js';
import { registerSubmissionAnalysisTools } from './tools/submission-analysis.js';
import { registerSubmissionBrowseTools } from './tools/submission-browse.js';
import { registerSubmissionDynamicTools } from './tools/submission-dynamic.js';
import { registerSubmissionNetworkTools } from './tools/submission-network.js';
import { registerSubmissionScanTools } from './tools/submission-scan.js';
import { registerSubmissionThreatTools } from './tools/submission-threat.js';
import { registerSubmissionUrlTools } from './tools/submission-url.js';
import { registerSubmitTools } from './tools/submit.js';

export function registerApiTools(server: McpServer): void {
	registerAccountTools(server);
	registerConfigTools(server);
	registerSubmissionBrowseTools(server);
	registerSubmissionAnalysisTools(server);
	registerSubmissionThreatTools(server);
	registerSubmissionDynamicTools(server);
	registerSubmissionScanTools(server);
	registerSubmissionNetworkTools(server);
	registerSubmissionUrlTools(server);
	registerDownloadTools(server);
	registerSubmitTools(server);
}
