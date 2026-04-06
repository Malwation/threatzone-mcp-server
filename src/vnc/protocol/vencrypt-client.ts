import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { AuthenticationError, ConnectionError, TimeoutError } from '../errors.js';
import type { RfbBackend, RfbRect } from './rfb-backend.js';
import { type WebSocketTransport, wsConnect } from './ws-transport.js';

/* ------------------------------------------------------------------ */
/*  RFB protocol constants                                             */
/* ------------------------------------------------------------------ */

const CLIENT_MSG = {
	setPixelFormat: 0,
	setEncodings: 2,
	fbUpdate: 3,
	keyEvent: 4,
	pointerEvent: 5,
	clientCutText: 6,
} as const;

const SERVER_MSG = {
	fbUpdate: 0,
	setColorMap: 1,
	bell: 2,
	cutText: 3,
} as const;

const ENCODINGS = {
	raw: 0,
	copyRect: 1,
	pseudoDesktopSize: -223,
	extendedClipboard: -260,
} as const;

const VENCRYPT_SUBTYPES = {
	plain: 256,
	tlsPlain: 259,
} as const;

/* ------------------------------------------------------------------ */
/*  Buffered reader over a socket / TLS stream                         */
/* ------------------------------------------------------------------ */

class BufferedReader {
	private chunks: Buffer[] = [];
	private buffered = 0;
	private waiting: { needed: number; resolve: (buf: Buffer) => void } | null = null;
	private errorHandler: ((err: Error) => void) | null = null;
	private endHandler: (() => void) | null = null;

	constructor(private stream: EventEmitter) {
		stream.on('data', (data: Buffer) => {
			this.chunks.push(data);
			this.buffered += data.length;
			this.tryDeliver();
		});
		stream.on('error', (err) => this.errorHandler?.(err));
		stream.on('end', () => this.endHandler?.());
	}

	onError(handler: (err: Error) => void): void {
		this.errorHandler = handler;
	}

	onEnd(handler: () => void): void {
		this.endHandler = handler;
	}

	read(n: number): Promise<Buffer> {
		return new Promise<Buffer>((resolve) => {
			this.waiting = { needed: n, resolve };
			this.tryDeliver();
		});
	}

	async readUInt8(): Promise<number> {
		const buf = await this.read(1);
		return buf[0];
	}

	async readUInt16BE(): Promise<number> {
		const buf = await this.read(2);
		return buf.readUInt16BE(0);
	}

	async readUInt32BE(): Promise<number> {
		const buf = await this.read(4);
		return buf.readUInt32BE(0);
	}

	async readInt32BE(): Promise<number> {
		const buf = await this.read(4);
		return buf.readInt32BE(0);
	}

	/** Swap in a new underlying stream (used after TLS upgrade). */
	replaceStream(newStream: EventEmitter): void {
		this.stream.removeAllListeners('data');
		this.stream = newStream;
		newStream.on('data', (data: Buffer) => {
			this.chunks.push(data);
			this.buffered += data.length;
			this.tryDeliver();
		});
		newStream.on('error', (err) => this.errorHandler?.(err));
		newStream.on('end', () => this.endHandler?.());
	}

	private tryDeliver(): void {
		if (!this.waiting || this.buffered < this.waiting.needed) return;
		const { needed, resolve } = this.waiting;
		this.waiting = null;

		const merged = Buffer.concat(this.chunks);
		this.chunks = merged.length > needed ? [merged.subarray(needed)] : [];
		this.buffered = merged.length - needed;
		resolve(merged.subarray(0, needed));
	}
}

/* ------------------------------------------------------------------ */
/*  VeNCrypt client implementing RfbBackend                            */
/* ------------------------------------------------------------------ */

export interface VeNCryptConnectOptions {
	host: string;
	port: number;
	username: string;
	password: string;
	wsUrl?: string;
	wsHeaders?: Record<string, string>;
}

export class VeNCryptClient extends EventEmitter implements RfbBackend {
	/* RfbBackend properties — set during ServerInit */
	width = 0;
	height = 0;
	bpp = 0;
	depth = 0;
	isBigEndian = 0;
	isTrueColor = 0;
	redMax = 0;
	greenMax = 0;
	blueMax = 0;
	redShift = 0;
	greenShift = 0;
	blueShift = 0;

	private socket: net.Socket | WebSocketTransport | null = null;
	private tlsSocket: tls.TLSSocket | null = null;
	private reader: BufferedReader | null = null;
	private readonly options: VeNCryptConnectOptions;
	private serverSupportsExtClipboard = false;

	constructor(options: VeNCryptConnectOptions) {
		super();
		this.options = options;
	}

	/* -------------------------------------------------------------- */
	/*  Public RfbBackend methods                                      */
	/* -------------------------------------------------------------- */

	requestUpdate(incremental: boolean, x: number, y: number, w: number, h: number): void {
		const buf = Buffer.alloc(10);
		buf[0] = CLIENT_MSG.fbUpdate;
		buf[1] = incremental ? 1 : 0;
		buf.writeUInt16BE(x, 2);
		buf.writeUInt16BE(y, 4);
		buf.writeUInt16BE(w, 6);
		buf.writeUInt16BE(h, 8);
		this.write(buf);
	}

	keyEvent(keysym: number, down: number): void {
		const buf = Buffer.alloc(8);
		buf[0] = CLIENT_MSG.keyEvent;
		buf[1] = down;
		buf.writeUInt32BE(keysym, 4);
		this.write(buf);
	}

	pointerEvent(x: number, y: number, buttonMask: number): void {
		const buf = Buffer.alloc(6);
		buf[0] = CLIENT_MSG.pointerEvent;
		buf[1] = buttonMask;
		buf.writeUInt16BE(x, 2);
		buf.writeUInt16BE(y, 4);
		this.write(buf);
	}

	clientCutText(text: string): void {
		if (this.serverSupportsExtClipboard) {
			const utf8Buf = Buffer.from(text, 'utf-8');
			const compressed = zlib.deflateSync(utf8Buf);
			const payload = Buffer.alloc(4 + 4 + compressed.length);
			payload.writeUInt32BE(3, 0); // flags: text(1) | provide(2)
			payload.writeUInt32BE(utf8Buf.length, 4);
			compressed.copy(payload, 8);

			const header = Buffer.alloc(8);
			header[0] = CLIENT_MSG.clientCutText;
			header.writeUInt32BE((payload.length | 0x80000000) >>> 0, 4);
			this.write(Buffer.concat([header, payload]));
		} else {
			const textBuf = Buffer.from(text, 'latin1');
			const buf = Buffer.alloc(8 + textBuf.length);
			buf[0] = CLIENT_MSG.clientCutText;
			buf.writeUInt32BE(textBuf.length, 4);
			textBuf.copy(buf, 8);
			this.write(buf);
		}
	}

	private sendExtendedClipboardCaps(): void {
		const payload = Buffer.alloc(4 + 4);
		payload.writeUInt32BE(17, 0); // flags: caps(16) | text(1)
		payload.writeUInt32BE(10 * 1024 * 1024, 4); // 10MB max

		const header = Buffer.alloc(8);
		header[0] = CLIENT_MSG.clientCutText;
		header.writeUInt32BE((payload.length | 0x80000000) >>> 0, 4);
		this.write(Buffer.concat([header, payload]));
	}

	end(): void {
		this.tlsSocket?.destroy();
		this.socket?.destroy();
		this.socket = null;
		this.tlsSocket = null;
	}

	/* -------------------------------------------------------------- */
	/*  Connection + handshake                                         */
	/* -------------------------------------------------------------- */

	async connect(timeoutMs = 10000): Promise<void> {
		const socket = await this.transportConnect(timeoutMs);
		this.socket = socket;
		this.reader = new BufferedReader(socket);

		this.reader.onError((err) => this.emit('error', err));
		this.reader.onEnd(() => this.emit('end'));

		try {
			await Promise.race([
				this.handshake(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new ConnectionError('VeNCrypt handshake timed out')), timeoutMs),
				),
			]);
		} catch (err) {
			this.end();
			throw err;
		}
	}

	/* -------------------------------------------------------------- */
	/*  Handshake phases                                               */
	/* -------------------------------------------------------------- */

	private async handshake(): Promise<void> {
		const reader = this.reader!;

		// 1. Version negotiation
		const versionBuf = await reader.read(12);
		const _serverVersion = versionBuf.toString('ascii').trim();
		this.write(Buffer.from('RFB 003.008\n', 'ascii'));

		// 2. Read security types
		const numTypes = await reader.readUInt8();
		if (numTypes === 0) {
			const errLen = await reader.readUInt32BE();
			const errMsg = (await reader.read(errLen)).toString('utf-8');
			throw new ConnectionError(`VNC server error: ${errMsg}`);
		}

		const secTypes = await reader.read(numTypes);
		const typeList: number[] = [];
		for (let i = 0; i < numTypes; i++) typeList.push(secTypes[i]);

		// 3. Select security type
		if (typeList.includes(1)) {
			// Security type None — no auth needed
			this.write(Buffer.from([1]));
			// RFB 3.8: read security result even for None
			const secResult = await reader.readUInt32BE();
			if (secResult !== 0) {
				throw new ConnectionError('Security type None rejected by server');
			}
			await this.rfbInit();
			return;
		}

		if (!typeList.includes(19)) {
			throw new ConnectionError(
				`Server does not support VeNCrypt (type 19) or None (type 1). Available types: [${typeList.join(', ')}]`,
			);
		}

		this.write(Buffer.from([19]));

		// 4. VeNCrypt version exchange
		const vencryptMajor = await reader.readUInt8();
		const vencryptMinor = await reader.readUInt8();

		if (vencryptMajor < 0 || vencryptMinor < 2) {
			throw new ConnectionError(`Unsupported VeNCrypt version ${vencryptMajor}.${vencryptMinor}`);
		}

		// Send our VeNCrypt version (0.2)
		this.write(Buffer.from([0, 2]));

		// Read version ack
		const vencryptAck = await reader.readUInt8();
		if (vencryptAck !== 0) {
			throw new ConnectionError('VeNCrypt version negotiation failed');
		}

		// 5. Read VeNCrypt subtypes
		const numSubtypes = await reader.readUInt8();
		const subtypeIds: number[] = [];
		for (let i = 0; i < numSubtypes; i++) {
			subtypeIds.push(await reader.readUInt32BE());
		}

		// Prefer TLS+Plain (259), fallback to Plain (256)
		let selectedSubtype: number;
		if (subtypeIds.includes(VENCRYPT_SUBTYPES.tlsPlain)) {
			selectedSubtype = VENCRYPT_SUBTYPES.tlsPlain;
		} else if (subtypeIds.includes(VENCRYPT_SUBTYPES.plain)) {
			selectedSubtype = VENCRYPT_SUBTYPES.plain;
		} else {
			throw new ConnectionError(
				`No supported VeNCrypt subtype. Server offers: [${subtypeIds.join(', ')}]`,
			);
		}

		// Send selected subtype
		const subtypeBuf = Buffer.alloc(4);
		subtypeBuf.writeUInt32BE(selectedSubtype, 0);
		this.write(subtypeBuf);

		// 6. TLS upgrade if needed
		if (selectedSubtype === VENCRYPT_SUBTYPES.tlsPlain) {
			await this.upgradeTls();
		}

		// 7. Send username + password (Plain auth)
		await this.sendPlainAuth();

		// 8. Read security result
		const secResult = await this.reader!.readUInt32BE();
		if (secResult !== 0) {
			// Try to read error message
			try {
				const errLen = await this.reader!.readUInt32BE();
				const errMsg = (await this.reader!.read(errLen)).toString('utf-8');
				throw new AuthenticationError(`Authentication failed: ${errMsg}`);
			} catch (err) {
				if (err instanceof AuthenticationError) throw err;
				throw new AuthenticationError('Authentication failed');
			}
		}

		// 9. ClientInit → ServerInit → SetPixelFormat → SetEncodings
		await this.rfbInit();
	}

	private async upgradeTls(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const tlsSocket = tls.connect(
				{
					socket: this.socket! as net.Socket,
					rejectUnauthorized: false,
				},
				() => {
					this.tlsSocket = tlsSocket;
					this.reader!.replaceStream(tlsSocket);
					resolve();
				},
			);
			tlsSocket.on('error', (err) => {
				reject(new ConnectionError(`TLS handshake failed: ${err.message}`));
			});
		});
	}

	private async sendPlainAuth(): Promise<void> {
		const reader = this.reader!;
		const { username, password } = this.options;
		const userBuf = Buffer.from(username, 'utf-8');
		const passBuf = Buffer.from(password, 'utf-8');

		const authBuf = Buffer.alloc(8 + userBuf.length + passBuf.length);
		authBuf.writeUInt32BE(userBuf.length, 0);
		authBuf.writeUInt32BE(passBuf.length, 4);
		userBuf.copy(authBuf, 8);
		passBuf.copy(authBuf, 8 + userBuf.length);

		this.write(authBuf);
	}

	private async rfbInit(): Promise<void> {
		const reader = this.reader!;

		// ClientInit — shared connection
		this.write(Buffer.from([1]));

		// ServerInit
		this.width = await reader.readUInt16BE();
		this.height = await reader.readUInt16BE();

		// Pixel format (16 bytes)
		const pf = await reader.read(16);
		this.bpp = pf[0];
		this.depth = pf[1];
		this.isBigEndian = pf[2];
		this.isTrueColor = pf[3];
		this.redMax = pf.readUInt16BE(4);
		this.greenMax = pf.readUInt16BE(6);
		this.blueMax = pf.readUInt16BE(8);
		this.redShift = pf[10];
		this.greenShift = pf[11];
		this.blueShift = pf[12];
		// bytes 13-15 are padding

		// Desktop name
		const nameLen = await reader.readUInt32BE();
		await reader.read(nameLen); // discard title

		// SetPixelFormat — echo the server's pixel format back
		const spf = Buffer.alloc(20);
		spf[0] = CLIENT_MSG.setPixelFormat;
		// bytes 1-3 are padding
		pf.copy(spf, 4);
		this.write(spf);

		// SetEncodings
		const encodingList = [ENCODINGS.raw, ENCODINGS.copyRect, ENCODINGS.pseudoDesktopSize];
		const se = Buffer.alloc(4 + encodingList.length * 4);
		se[0] = CLIENT_MSG.setEncodings;
		se.writeUInt16BE(encodingList.length, 2);
		for (let i = 0; i < encodingList.length; i++) {
			se.writeInt32BE(encodingList[i], 4 + i * 4);
		}
		this.write(se);

		// Note: extended clipboard caps sent only after server announces support

		// Request initial framebuffer update
		this.requestUpdate(false, 0, 0, this.width, this.height);

		// Start the message loop
		this.messageLoop();

		this.emit('connect');
	}

	/* -------------------------------------------------------------- */
	/*  RFB message loop (post-init)                                   */
	/* -------------------------------------------------------------- */

	private async messageLoop(): Promise<void> {
		const reader = this.reader!;

		try {
			while (true) {
				const msgType = await reader.readUInt8();

				switch (msgType) {
					case SERVER_MSG.fbUpdate:
						await this.readFbUpdate(reader);
						break;
					case SERVER_MSG.setColorMap:
						await this.readColorMap(reader);
						break;
					case SERVER_MSG.bell:
						this.emit('bell');
						break;
					case SERVER_MSG.cutText:
						await this.readCutText(reader);
						break;
					default:
						// Unknown message — skip
						console.error(`VeNCrypt: unknown server message type ${msgType}`);
						return;
				}
			}
		} catch (err) {
			// Socket closed or read error — expected on disconnect
			if (this.socket?.destroyed || this.tlsSocket?.destroyed) return;
			this.emit('error', err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async readFbUpdate(reader: BufferedReader): Promise<void> {
		await reader.read(1); // padding
		const numRects = await reader.readUInt16BE();

		for (let i = 0; i < numRects; i++) {
			const x = await reader.readUInt16BE();
			const y = await reader.readUInt16BE();
			const width = await reader.readUInt16BE();
			const height = await reader.readUInt16BE();
			const encoding = await reader.readInt32BE();

			if (encoding === ENCODINGS.pseudoDesktopSize) {
				this.width = width;
				this.height = height;
				this.emit('resize', { width, height });
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: Buffer.alloc(0),
					buffer: Buffer.alloc(0),
				} satisfies RfbRect);
				continue;
			}

			if (encoding === ENCODINGS.copyRect) {
				const copyData = await reader.read(4);
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: copyData,
					buffer: copyData,
				} satisfies RfbRect);
				continue;
			}

			if (encoding === ENCODINGS.raw) {
				const bytesPerPixel = this.bpp >> 3;
				const pixelData = await reader.read(width * height * bytesPerPixel);
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: pixelData,
					buffer: pixelData,
				} satisfies RfbRect);
				continue;
			}

			// Unknown encoding — cannot determine length, bail
			console.error(`VeNCrypt: unknown encoding ${encoding}`);
			return;
		}
	}

	private async readColorMap(reader: BufferedReader): Promise<void> {
		await reader.read(1); // padding
		const firstColor = await reader.readUInt16BE();
		const numColors = await reader.readUInt16BE();
		await reader.read(numColors * 6); // skip RGB values
	}

	private async readCutText(reader: BufferedReader): Promise<void> {
		await reader.read(3); // padding
		const rawLen = await reader.readUInt32BE();

		if (rawLen & 0x80000000) {
			const payloadLen = rawLen & 0x7fffffff;
			const payload = await reader.read(payloadLen);
			const flags = payload.readUInt32BE(0);

			if (flags & 16) {
				this.serverSupportsExtClipboard = true;
				this.sendExtendedClipboardCaps();
				return;
			}
			if (flags & 2 && flags & 1) {
				const compressed = payload.subarray(8);
				try {
					const text = zlib.inflateSync(compressed).toString('utf-8');
					this.emit('clipboard', text);
				} catch {
					this.emit('clipboard', compressed.toString('utf-8'));
				}
				return;
			}
			return;
		}

		const text = (await reader.read(rawLen)).toString('latin1');
		this.emit('clipboard', text);
	}

	/* -------------------------------------------------------------- */
	/*  Helpers                                                        */
	/* -------------------------------------------------------------- */

	private async transportConnect(timeoutMs: number): Promise<net.Socket | WebSocketTransport> {
		if (this.options.wsUrl) {
			return wsConnect(this.options.wsUrl, timeoutMs, this.options.wsHeaders);
		}
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = new net.Socket();
			const timeout = setTimeout(() => {
				socket.destroy();
				reject(new TimeoutError('VNC TCP connect', timeoutMs));
			}, timeoutMs);

			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(new ConnectionError(`TCP connection failed: ${err.message}`));
			});

			socket.connect(this.options.port, this.options.host, () => {
				clearTimeout(timeout);
				resolve(socket);
			});
		});
	}

	private write(data: Buffer): void {
		const target = this.tlsSocket ?? this.socket;
		if (target && !target.destroyed) {
			target.write(data);
		}
	}
}
