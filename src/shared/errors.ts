export class McpToolError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = 'McpToolError';
		this.code = code;
	}
}
