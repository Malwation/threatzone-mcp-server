import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ConnectionError, TimeoutError } from '../errors.js';

export interface WsConnectOptions {
	url: string;
	headers?: Record<string, string>;
}

export class WebSocketTransport extends EventEmitter {
	private ws: WebSocket;

	constructor(url: string, headers?: Record<string, string>) {
		super();
		this.ws = new WebSocket(url, ['binary'], {
			rejectUnauthorized: false,
			headers: {
				Origin: new URL(url).origin,
				...headers,
			},
		});
		this.ws.binaryType = 'nodebuffer';

		this.ws.on('open', () => this.emit('connect'));
		this.ws.on('message', (data: Buffer) => this.emit('data', data));
		this.ws.on('error', (err: Error) => this.emit('error', err));
		this.ws.on('close', () => this.emit('end'));
	}

	write(data: Buffer): void {
		if (this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		}
	}

	destroy(): void {
		this.ws.close();
	}

	get destroyed(): boolean {
		return this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
	}
}

export function wsConnect(
	url: string,
	timeoutMs: number,
	headers?: Record<string, string>,
): Promise<WebSocketTransport> {
	return new Promise<WebSocketTransport>((resolve, reject) => {
		const transport = new WebSocketTransport(url, headers);
		const timeout = setTimeout(() => {
			transport.destroy();
			reject(new TimeoutError('WebSocket connect', timeoutMs));
		}, timeoutMs);

		transport.on('connect', () => {
			clearTimeout(timeout);
			resolve(transport);
		});

		transport.on('error', (err: Error) => {
			clearTimeout(timeout);
			reject(new ConnectionError(`WebSocket connection failed: ${err.message}`));
		});
	});
}
