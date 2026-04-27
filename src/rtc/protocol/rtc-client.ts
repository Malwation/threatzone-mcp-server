import {
	RTCRtpCodecParameters as CodecParams,
	type MediaStreamTrack,
	type RTCDataChannel,
	RTCPeerConnection,
	type RTCRtpCodecParameters,
} from 'werift';
import type {
	DeviceButton,
	ImageFormat,
	Region,
	RemoteSession,
	RemoteSessionConfig,
	RemoteSessionState,
	RemoteTransport,
	ScreenSize,
} from '../../shared/remote-session.js';
import { MissingParameterSetsError, RtcConnectionError } from '../errors.js';
import { ControlChannel, type DataChannelLike } from './control-channel.js';
import { keysymToCode } from './keysym-to-code.js';
import {
	type IceCandidateInit,
	openSignaling,
	type Signaling,
	type SignalingAnswer,
} from './signaling.js';
import { VideoSink } from './video-sink.js';

/**
 * Codec list offered to the gateway. H.264 is the only codec the Android-side
 * gateway actually answers — VP8/VP9 offers from @roamhq/wrtc were silently
 * ignored, which is what motivated the switch to werift in the first place.
 * profile-level-id 42e01f = Baseline 3.1 (the broadly-compatible mobile profile).
 */
const VIDEO_CODECS: RTCRtpCodecParameters[] = [
	new CodecParams({
		mimeType: 'video/H264',
		clockRate: 90000,
		payloadType: 102,
		rtcpFeedback: [
			{ type: 'nack' },
			{ type: 'nack', parameter: 'pli' },
			{ type: 'goog-remb' },
			{ type: 'transport-cc' },
		],
		parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
	}),
];

export interface RtcClientConfig extends RemoteSessionConfig {
	signalingUrl: string;
}

export interface RtcClientOptions {
	connectTimeoutMs?: number;
	firstFrameTimeoutMs?: number;
}

export class RtcClient implements RemoteSession {
	readonly transport: RemoteTransport = 'rtc';
	readonly config: RtcClientConfig;
	state: RemoteSessionState = 'disconnected';

	private pc: RTCPeerConnection | null = null;
	private signaling: Signaling | null = null;
	private dc: RTCDataChannel | null = null;
	private control: ControlChannel | null = null;
	private videoSink: VideoSink | null = null;
	// Held so requestKeyframe() can ask werift to send a fresh PLI to the gateway
	// when the H.264 decoder gets stuck on a parameter-set-less GOP.
	private videoTransceiver: ReturnType<RTCPeerConnection['addTransceiver']> | null = null;
	private videoTrackSsrc: number | null = null;
	private remoteReady = false;
	private pendingIce: IceCandidateInit[] = [];
	private connectTimeoutMs: number;
	private firstFrameTimeoutMs: number;
	private lastButtonMask = 0;
	// Most recent device → host clipboard text. Populated by the gateway whenever
	// the Android clipboard changes (clipboard_autosync=true on scrcpy). Mirrors
	// the VNC client's clipboard cache so clipboard_read returns the same shape.
	private lastClipboard: string | null = null;

	constructor(config: RtcClientConfig, options?: RtcClientOptions) {
		this.config = config;
		this.connectTimeoutMs =
			options?.connectTimeoutMs ?? (Number(process.env.RTC_CONNECT_TIMEOUT) || 15000);
		this.firstFrameTimeoutMs = options?.firstFrameTimeoutMs ?? this.connectTimeoutMs;
	}

	get screenSize(): ScreenSize | null {
		return this.videoSink?.getScreenSize() ?? null;
	}

	async connect(): Promise<void> {
		this.state = 'connecting';
		const t0 = Date.now();
		const log = (msg: string) =>
			console.error(`[rtc][${(Date.now() - t0).toString().padStart(5)}ms] ${msg}`);

		// Single shared rejector so signaling death / pc failure / dc error /
		// overall timeout all rejects every in-flight handshake step at once.
		let bail: ((err: Error) => void) | null = null;
		const bailable = <T>(p: Promise<T>): Promise<T> =>
			new Promise<T>((resolve, reject) => {
				const prevBail = bail;
				const wrapped = (err: Error) => {
					if (prevBail) prevBail(err);
					reject(err);
				};
				bail = wrapped;
				p.then(resolve, reject);
			});

		const overall = new Promise<never>((_, reject) => {
			const id = setTimeout(() => {
				reject(
					new RtcConnectionError(`RTC connect exceeded ${this.connectTimeoutMs}ms overall budget`),
				);
			}, this.connectTimeoutMs);
			id.unref?.();
		});

		try {
			log(`opening signaling ${this.config.signalingUrl}`);
			this.signaling = await Promise.race([
				openSignaling(this.config.signalingUrl, this.connectTimeoutMs),
				overall,
			]);
			log('signaling open');

			this.signaling.once('error', (err: Error) => {
				log(`signaling error: ${err.message}`);
				bail?.(err);
			});
			this.signaling.once('close', () => {
				log('signaling closed unexpectedly');
				bail?.(new RtcConnectionError('Signaling closed during handshake'));
			});

			this.pc = new RTCPeerConnection({ codecs: { video: VIDEO_CODECS } });

			// Forward locally-gathered ICE.
			this.pc.onIceCandidate.subscribe((cand) => {
				if (!cand || !this.signaling) return;
				const json: IceCandidateInit = {
					candidate: cand.candidate,
					sdpMid: cand.sdpMid,
					sdpMLineIndex: cand.sdpMLineIndex,
					usernameFragment: cand.usernameFragment ?? null,
				};
				this.signaling.sendIce(json);
			});

			// Buffer inbound ICE until setRemoteDescription resolves.
			this.signaling.on('ice', (candidate: IceCandidateInit) => {
				if (this.remoteReady && this.pc) {
					this.pc.addIceCandidate(candidate as never).catch((err) => {
						log(`addIceCandidate failed: ${err}`);
					});
				} else {
					this.pendingIce.push(candidate);
				}
			});

			// Track arrival → wire up the H.264 → ffmpeg pipeline.
			const transceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
			this.videoTransceiver = transceiver;
			const trackPromise = new Promise<void>((resolve) => {
				transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
					if (this.videoSink) return;
					log(`track arrived: ${track.kind} ${track.codec?.mimeType ?? '?'}`);
					this.videoSink = new VideoSink();
					track.onReceiveRtp.subscribe((pkt) => {
						this.videoSink?.pushRtpPayload(pkt.payload);
					});
					// Capture the SSRC on the first packet so requestKeyframe() can
					// target it later, and send the initial PLI here so the gateway
					// emits a keyframe promptly (some only do on demand).
					track.onReceiveRtp.once(() => {
						const ssrc = track.ssrc;
						if (typeof ssrc === 'number') {
							this.videoTrackSsrc = ssrc;
							transceiver.receiver.sendRtcpPLI(ssrc).catch((err) => {
								log(`PLI request failed: ${err}`);
							});
						}
					});
					resolve();
				});
			});

			this.pc.connectionStateChange.subscribe((s) => {
				log(`pc state → ${s}`);
				if (s === 'failed' || s === 'closed' || s === 'disconnected') {
					if (this.state === 'connecting') {
						bail?.(new RtcConnectionError(`Peer connection ${s} during handshake`));
					} else if (this.state === 'connected') {
						this.state = 'disconnected';
					}
				}
			});

			// Order matters: declare data channel BEFORE createOffer so the SDP
			// includes the data m-line (mirrors rtc-session.js:87-88).
			this.dc = this.pc.createDataChannel('control', { ordered: true });

			// Device → host messages on the same control channel (clipboard sync today).
			// Mirrors apps/novnc/vnc/www/core/rtc-session.js:146,422-444.
			this.dc.onMessage.subscribe((data) => this.onDeviceMessage(data));

			const dcOpen = new Promise<void>((resolve, reject) => {
				if (!this.dc) return;
				if (this.dc.readyState === 'open') {
					this.control = new ControlChannel(this.dc as DataChannelLike);
					resolve();
					return;
				}
				this.dc.stateChange.subscribe((s) => {
					if (s === 'open') {
						log('data channel open');
						this.control = new ControlChannel(this.dc as DataChannelLike);
						resolve();
					} else if (s === 'closed' || s === 'closing') {
						reject(new RtcConnectionError(`Data channel transitioned to ${s}`));
					}
				});
			});

			const answerApplied = new Promise<void>((resolve, reject) => {
				if (!this.signaling) return;
				this.signaling.once('answer', async (msg: SignalingAnswer) => {
					log(`answer received (${msg.sdp.length} bytes sdp)`);
					if (!this.pc) return reject(new RtcConnectionError('Peer connection gone'));
					try {
						await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
						this.remoteReady = true;
						for (const c of this.pendingIce) {
							this.pc
								.addIceCandidate(c as never)
								.catch((err) => log(`drained addIceCandidate failed: ${err}`));
						}
						this.pendingIce = [];
						resolve();
					} catch (err) {
						reject(
							new RtcConnectionError(
								`setRemoteDescription failed: ${err instanceof Error ? err.message : String(err)}`,
							),
						);
					}
				});
			});

			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);
			this.signaling.sendOffer(offer.sdp);
			log(`offer sent (${offer.sdp.length} bytes sdp)`);

			await Promise.race([bailable(answerApplied), overall]);
			await Promise.race([bailable(trackPromise), overall]);
			await Promise.race([bailable(dcOpen), overall]);
			if (!this.videoSink) {
				throw new RtcConnectionError('Video sink was never attached');
			}
			await Promise.race([
				bailable(this.videoSink.waitForFirstFrame(this.firstFrameTimeoutMs)),
				overall,
			]);
			log(`first frame decoded; screen ${this.screenSize?.width}x${this.screenSize?.height}`);

			this.state = 'connected';
		} catch (err) {
			this.state = 'error';
			this.cleanup();
			throw err;
		}
	}

	disconnect(): void {
		this.cleanup();
		this.state = 'disconnected';
	}

	private cleanup(): void {
		try {
			this.videoSink?.stop();
		} catch {
			/* ignore */
		}
		try {
			this.dc?.close();
		} catch {
			/* ignore */
		}
		try {
			this.pc?.close();
		} catch {
			/* ignore */
		}
		try {
			this.signaling?.close();
		} catch {
			/* ignore */
		}
		this.videoSink = null;
		this.control = null;
		this.dc = null;
		this.pc = null;
		this.signaling = null;
		this.videoTransceiver = null;
		this.videoTrackSsrc = null;
		this.remoteReady = false;
		this.pendingIce = [];
		this.lastButtonMask = 0;
	}

	/**
	 * Ask the gateway to emit a fresh keyframe by sending an RTCP PLI on the
	 * video track. Resolves true when the next IDR arrives, false on timeout.
	 * Used by `screenshot()` to recover from a `MissingParameterSetsError`.
	 */
	async requestKeyframe(timeoutMs = 700): Promise<boolean> {
		if (!this.videoTransceiver || this.videoTrackSsrc === null || !this.videoSink) {
			return false;
		}
		try {
			await this.videoTransceiver.receiver.sendRtcpPLI(this.videoTrackSsrc);
		} catch {
			return false;
		}
		return this.videoSink.waitForNextKeyframe(timeoutMs);
	}

	async screenshot(
		format: ImageFormat = 'png',
		region?: Region,
		quality?: number,
	): Promise<Buffer> {
		this.ensureConnected();
		if (!this.videoSink) throw new RtcConnectionError('No video sink');
		try {
			return await this.videoSink.frameToImage(format, region, quality);
		} catch (err) {
			// Encoder restarts (page navigation, app switch) can leave the GOP
			// referencing parameter sets we haven't captured. Force a fresh keyframe
			// from the gateway and retry once before surfacing the error.
			if (err instanceof MissingParameterSetsError) {
				console.error('[rtc] decode missing PPS — requesting fresh keyframe');
				const ok = await this.requestKeyframe(700);
				if (ok && this.videoSink) {
					return this.videoSink.frameToImage(format, region, quality);
				}
			}
			throw err;
		}
	}

	waitForRect(timeoutMs: number): Promise<boolean> {
		this.ensureConnected();
		if (!this.videoSink) return Promise.resolve(false);
		return this.videoSink.waitForFrameChange(timeoutMs);
	}

	sendKey(keysym: number, down: boolean): void {
		this.ensureConnected();
		const mapping = keysymToCode(keysym);
		if (!mapping) {
			console.error(`[rtc] no DOM code mapping for keysym 0x${keysym.toString(16)}; skipping`);
			return;
		}
		const c = this.requireControl();
		if (mapping.shifted) {
			if (down) {
				c.sendKey('down', 'ShiftLeft');
				c.sendKey('down', mapping.code);
			} else {
				c.sendKey('up', mapping.code);
				c.sendKey('up', 'ShiftLeft');
			}
		} else {
			c.sendKey(down ? 'down' : 'up', mapping.code);
		}
	}

	sendPointer(x: number, y: number, buttonMask: number): void {
		this.ensureConnected();
		const size = this.screenSize;
		if (!size) throw new RtcConnectionError('Screen size unknown — no video frame yet');
		const c = this.requireControl();

		const nx = x / size.width;
		const ny = y / size.height;

		const scrollUp = (buttonMask & 8) !== 0;
		const scrollDown = (buttonMask & 16) !== 0;
		const scrollLeft = (buttonMask & 32) !== 0;
		const scrollRight = (buttonMask & 64) !== 0;
		if (scrollUp || scrollDown || scrollLeft || scrollRight) {
			let dx = 0;
			let dy = 0;
			if (scrollUp) dy = -1;
			else if (scrollDown) dy = 1;
			if (scrollLeft) dx = -1;
			else if (scrollRight) dx = 1;
			c.sendScroll(nx, ny, dx, dy);
			return;
		}

		if (buttonMask & 2 || buttonMask & 4) {
			console.error(
				'[rtc] middle/right mouse buttons are not supported on Android touch; ignoring',
			);
			return;
		}

		const leftNow = (buttonMask & 1) !== 0;
		const leftBefore = (this.lastButtonMask & 1) !== 0;
		if (leftNow && !leftBefore) c.sendTouch('down', nx, ny);
		else if (!leftNow && leftBefore) c.sendTouch('up', nx, ny);
		else if (leftNow && leftBefore) c.sendTouch('move', nx, ny);
		// 0→0 (hover): no-op (matches pointer-to-gateway.js:69-73).

		this.lastButtonMask = buttonMask;
	}

	sendDeviceButton(button: DeviceButton): void {
		this.ensureConnected();
		this.requireControl().sendDeviceButton(button);
	}

	updateClipboard(text: string): void {
		this.ensureConnected();
		// paste=true matches the browser's Cmd/Ctrl+V intercept: the gateway sets
		// the device clipboard AND injects a paste keystroke so the text lands in
		// whatever input field is currently focused on the device.
		this.requireControl().sendClipboard(text, true);
	}

	getClipboard(): string | null {
		// Populated by onDeviceMessage as the gateway pushes clipboard updates.
		// Returns null until the device has sent at least one clipboard event.
		return this.lastClipboard;
	}

	requestFramebufferUpdate(_incremental: boolean): void {
		// RTC is push-based — no equivalent of an explicit RFB update request.
	}

	private ensureConnected(): void {
		if (this.state !== 'connected' || !this.pc) {
			throw new RtcConnectionError('RTC client is not connected');
		}
	}

	private requireControl(): ControlChannel {
		if (!this.control) throw new RtcConnectionError('Control channel not open');
		return this.control;
	}

	private onDeviceMessage(data: string | Buffer): void {
		// werift hands us either a string or a Buffer depending on how the gateway
		// framed the message. The browser does the same dance — see rtc-session.js:423-436.
		let text: string;
		try {
			text = typeof data === 'string' ? data : data.toString('utf-8');
		} catch {
			return;
		}
		let msg: { type?: unknown; text?: unknown };
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (msg.type === 'clipboard' && typeof msg.text === 'string') {
			this.lastClipboard = msg.text;
		}
	}
}
