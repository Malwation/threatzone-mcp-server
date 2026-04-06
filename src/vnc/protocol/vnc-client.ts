import { ConnectionError, TimeoutError } from '../errors.js';
import { Framebuffer } from './framebuffer.js';
import type {
	ImageFormat,
	Region,
	ScreenSize,
	VncSessionConfig,
	VncSessionState,
} from './protocol-types.js';
import { Ra2neClient } from './ra2ne-client.js';
import { createRfb2Backend, encodings, type RfbBackend, type RfbRect } from './rfb-backend.js';
import { probeServer } from './rfb-probe.js';
import { VeNCryptClient } from './vencrypt-client.js';

const SECURITY_NONE = 1;
const SECURITY_VNC = 2;
const SECURITY_RA2 = 5;
const SECURITY_RA2NE = 6;
const SECURITY_VENCRYPT = 19;
const SECURITY_RA2_256 = 129;
const SECURITY_RA2NE_256 = 133;

/** RA2ne variants: handshake encrypted, post-handshake unencrypted */
const RA2NE_TYPES = [SECURITY_RA2NE, 13, SECURITY_RA2NE_256];
/** RA2 variants: fully encrypted session */
const RA2_TYPES = [SECURITY_RA2, SECURITY_RA2_256];
/** All RSA-AES types */
const RSA_AES_TYPES = [...RA2NE_TYPES, ...RA2_TYPES];

interface ConnectedState {
	client: RfbBackend;
	framebuffer: Framebuffer;
	screenSize: ScreenSize;
}

export class VncClient {
	private client: RfbBackend | null = null;
	private framebuffer: Framebuffer | null = null;
	private connectTimeout: number;
	private screenshotTimeout: number;
	private lastClipboardText: string | null = null;

	state: VncSessionState = 'disconnected';
	screenSize: ScreenSize | null = null;
	readonly config: VncSessionConfig;

	constructor(
		config: VncSessionConfig,
		options?: { connectTimeout?: number; screenshotTimeout?: number },
	) {
		this.config = config;
		this.connectTimeout = options?.connectTimeout ?? 10000;
		this.screenshotTimeout = options?.screenshotTimeout ?? 5000;
	}

	async connect(): Promise<void> {
		this.state = 'connecting';

		try {
			if (this.config.wsUrl) {
				// WebSocket connection — can't probe, connect directly
				// The backend will negotiate security type during handshake
				if (this.config.username) {
					await this.connectRa2();
				} else {
					await this.connectVeNCrypt();
				}
			} else if (this.config.username) {
				// Username implies RSA-AES or VeNCrypt auth — connect directly
				await this.connectRa2();
			} else {
				// Probe to determine which backend to use
				const probe = await probeServer(this.config.host, this.config.port, this.connectTimeout);
				const types = probe.securityTypes;

				if (types.includes(SECURITY_NONE) || types.includes(SECURITY_VNC)) {
					await this.connectRfb2();
				} else {
					const rsaAesType = this.selectRsaAesType(types);
					if (rsaAesType !== null) {
						await this.connectRa2();
					} else if (types.includes(SECURITY_VENCRYPT)) {
						await this.connectVeNCrypt();
					} else {
						throw new ConnectionError(
							`Server security types [${types.join(', ')}] are not supported. ` +
								'Supported: None (1), VNC Auth (2), VeNCrypt (19), RA2/RA2ne (5/6/13/129/133).',
						);
					}
				}
			}
		} catch (err) {
			this.state = 'error';
			throw err;
		}
	}

	/** Select best RSA-AES security type: prefer RA2ne (unencrypted post-handshake) over RA2 */
	private selectRsaAesType(types: number[]): number | null {
		// Prefer RA2ne variants (simpler, no full-session encryption needed)
		for (const t of RA2NE_TYPES) {
			if (types.includes(t)) return t;
		}
		// Fall back to RA2 variants
		for (const t of RA2_TYPES) {
			if (types.includes(t)) return t;
		}
		return null;
	}

	private async connectRa2(): Promise<void> {
		const ra2 = new Ra2neClient({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username ?? '',
			password: this.config.password ?? '',
			wsUrl: this.config.wsUrl,
			wsHeaders: this.config.wsHeaders,
		});

		await ra2.connect(this.connectTimeout);

		this.client = ra2;
		this.state = 'connected';
		this.screenSize = { width: ra2.width, height: ra2.height };
		this.framebuffer = new Framebuffer(
			ra2.width,
			ra2.height,
			ra2.bpp ?? 32,
			ra2.redShift ?? 16,
			ra2.greenShift ?? 8,
			ra2.blueShift ?? 0,
		);

		this.attachListeners(ra2);
	}

	private async connectVeNCrypt(): Promise<void> {
		const vencrypt = new VeNCryptClient({
			host: this.config.host,
			port: this.config.port,
			username: this.config.username ?? '',
			password: this.config.password ?? '',
			wsUrl: this.config.wsUrl,
			wsHeaders: this.config.wsHeaders,
		});

		await vencrypt.connect(this.connectTimeout);

		this.client = vencrypt;
		this.state = 'connected';
		this.screenSize = { width: vencrypt.width, height: vencrypt.height };
		this.framebuffer = new Framebuffer(
			vencrypt.width,
			vencrypt.height,
			vencrypt.bpp ?? 32,
			vencrypt.redShift ?? 16,
			vencrypt.greenShift ?? 8,
			vencrypt.blueShift ?? 0,
		);

		this.attachListeners(vencrypt);
	}

	private connectRfb2(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.state = 'error';
				this.client?.end();
				reject(new TimeoutError('VNC connection', this.connectTimeout));
			}, this.connectTimeout);

			try {
				this.client = createRfb2Backend({
					host: this.config.host,
					port: this.config.port,
					password: this.config.password,
				});
			} catch (err) {
				clearTimeout(timeout);
				this.state = 'error';
				reject(new ConnectionError(`Failed to initiate VNC connection: ${String(err)}`));
				return;
			}

			const cli = this.client;

			cli.on('connect', () => {
				clearTimeout(timeout);
				this.state = 'connected';
				this.screenSize = { width: cli.width, height: cli.height };
				this.framebuffer = new Framebuffer(
					cli.width,
					cli.height,
					cli.bpp ?? 32,
					cli.redShift ?? 16,
					cli.greenShift ?? 8,
					cli.blueShift ?? 0,
				);
				this.attachListeners(cli);
				resolve();
			});

			cli.on('error', (err: string | Error) => {
				clearTimeout(timeout);
				const message = typeof err === 'string' ? err : err.message;
				if (this.state === 'connecting') {
					this.state = 'error';
					reject(new ConnectionError(message));
				} else {
					this.state = 'error';
				}
			});

			cli.on('end', () => {
				if (this.state !== 'error') {
					this.state = 'disconnected';
				}
			});
		});
	}

	private attachListeners(cli: RfbBackend): void {
		cli.on('rect', (rect: RfbRect) => {
			if (!this.framebuffer) return;

			if (rect.encoding === encodings.pseudoDesktopSize) {
				this.screenSize = { width: rect.width, height: rect.height };
				this.framebuffer.resize(rect.width, rect.height);
				return;
			}

			if (rect.encoding === encodings.copyRect) {
				const srcX = rect.data.readUInt16BE(0);
				const srcY = rect.data.readUInt16BE(2);
				this.framebuffer.copyRect(srcX, srcY, rect.x, rect.y, rect.width, rect.height);
				return;
			}

			const pixelData = rect.data ?? rect.buffer;
			if (pixelData) {
				this.framebuffer.updateRect(rect.x, rect.y, rect.width, rect.height, pixelData);
			}
		});

		cli.on('resize', (rect: { width: number; height: number }) => {
			this.screenSize = { width: rect.width, height: rect.height };
			this.framebuffer?.resize(rect.width, rect.height);
		});

		cli.on('clipboard', (text: string) => {
			this.lastClipboardText = text;
		});

		cli.on('error', (err: string | Error) => {
			if (this.state !== 'connecting') {
				this.state = 'error';
			}
		});

		cli.on('end', () => {
			if (this.state !== 'error') {
				this.state = 'disconnected';
			}
		});
	}

	disconnect(): void {
		if (this.client) {
			this.client.end();
			this.client = null;
		}
		this.state = 'disconnected';
		this.framebuffer = null;
		this.screenSize = null;
		this.lastClipboardText = null;
	}

	updateClipboard(text: string): void {
		const { client } = this.ensureConnected();
		client.clientCutText(text);
	}

	getClipboard(): string | null {
		this.ensureConnected();
		return this.lastClipboardText;
	}

	async screenshot(
		format: ImageFormat = 'png',
		region?: Region,
		quality?: number,
	): Promise<Buffer> {
		const { client, framebuffer, screenSize } = this.ensureConnected();

		client.requestUpdate(false, 0, 0, screenSize.width, screenSize.height);
		await this.waitForFrameUpdate(client);

		return framebuffer.toImage(format, region, quality);
	}

	sendKey(keysym: number, down: boolean): void {
		const { client } = this.ensureConnected();
		client.keyEvent(keysym, down ? 1 : 0);
	}

	sendPointer(x: number, y: number, buttonMask: number): void {
		const { client } = this.ensureConnected();
		client.pointerEvent(x, y, buttonMask);
	}

	requestFramebufferUpdate(incremental: boolean): void {
		const { client, screenSize } = this.ensureConnected();
		client.requestUpdate(incremental, 0, 0, screenSize.width, screenSize.height);
	}

	waitForRect(timeoutMs: number): Promise<boolean> {
		const { client } = this.ensureConnected();
		return new Promise<boolean>((resolve) => {
			const timeout = setTimeout(() => {
				client.removeListener('rect', onRect);
				resolve(false);
			}, timeoutMs);

			const onRect = () => {
				clearTimeout(timeout);
				client.removeListener('rect', onRect);
				resolve(true);
			};

			client.on('rect', onRect);
		});
	}

	private ensureConnected(): ConnectedState {
		if (this.state !== 'connected' || !this.client || !this.framebuffer || !this.screenSize) {
			throw new ConnectionError('VNC client is not connected');
		}
		return {
			client: this.client,
			framebuffer: this.framebuffer,
			screenSize: this.screenSize,
		};
	}

	private waitForFrameUpdate(client: RfbBackend): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new TimeoutError('framebuffer update', this.screenshotTimeout));
			}, this.screenshotTimeout);

			let debounceTimer: ReturnType<typeof setTimeout> | null = null;

			const onRect = () => {
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					cleanup();
					resolve();
				}, 100);
			};

			const cleanup = () => {
				clearTimeout(timeout);
				if (debounceTimer) clearTimeout(debounceTimer);
				client.removeListener('rect', onRect);
			};

			client.on('rect', onRect);
		});
	}
}
