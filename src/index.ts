import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerVncTools } from './vnc/register.js';

const server = new McpServer({
	name: 'threatzone-mcp',
	version: '1.0.0',
});

registerVncTools(server);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

process.on('uncaughtException', (err) => {
	console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (err) => {
	console.error('Unhandled rejection:', err);
});

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
