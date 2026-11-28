/**
 * `http`: Streamable HTTP (the default). Tools never read or write the server's own disk.
 * `stdio`: the client spawns the server locally, so tools may read and write local paths.
 */
export type TransportMode = 'http' | 'stdio';

/** Options that tool registration needs from the process entry point. */
export interface ToolContext {
	transportMode: TransportMode;
}

/** `MCP_TRANSPORT=stdio` selects stdio. Any other value, or no value, selects HTTP. */
export function parseTransportMode(value: string | undefined): TransportMode {
	return (value ?? 'http').toLowerCase() === 'stdio' ? 'stdio' : 'http';
}
