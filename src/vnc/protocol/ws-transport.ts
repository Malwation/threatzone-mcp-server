import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ConnectionError, TimeoutError } from '../errors.js';

export interface WsConnectOptions {
	url: string;
	headers?: Record<string, string>;
}

export class WebSocketTransport extends EventEmitter {
	private ws: WebSocket;
	/** Close code and reason from the gateway, for example `code 4401 (token expired)`. */
	closeDescription: string | undefined;
	/**
	 * Frames and the close that arrive before the first 'data' listener. The gateway can send the
	 * RFB version in the same packet as the upgrade response, so 'message' can fire right after 'open'.
	 */
	private early: Array<Buffer | null> | null = [];

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
		this.ws.on('message', (data: Buffer) => {
			if (this.early) this.early.push(data);
			else this.emit('data', data);
		});
		this.ws.on('error', (err: Error) => this.emit('error', err));
		this.ws.on('close', (code: number, reason: Buffer) => {
			const text = reason.toString('utf-8').trim();
			this.closeDescription = text ? `code ${code} (${text})` : `code ${code}`;
			if (this.early) this.early.push(null);
			else this.emit('end');
		});
		this.on('newListener', (event: string) => {
			if (event !== 'data' || !this.early) return;
			// Deliver after the reader attaches its 'error' and 'end' listeners too.
			queueMicrotask(() => {
				const early = this.early ?? [];
				this.early = null;
				for (const item of early) {
					if (item) this.emit('data', item);
					else this.emit('end');
				}
			});
		});
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
