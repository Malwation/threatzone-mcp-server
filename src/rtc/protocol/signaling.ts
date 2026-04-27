import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RtcConnectionError, RtcSignalingError } from '../errors.js';

/**
 * Minimal subset of IceCandidateInit we use. The DOM type isn't available
 * (we don't load lib.dom), and @roamhq/wrtc's re-exports degrade to `any` —
 * defining the shape locally keeps the signaling layer typed.
 */
export interface IceCandidateInit {
	candidate?: string;
	sdpMid?: string | null;
	sdpMLineIndex?: number | null;
	usernameFragment?: string | null;
}

export interface SignalingAnswer {
	type: 'answer';
	sdp: string;
}

export interface SignalingIce {
	type: 'ice';
	candidate: IceCandidateInit;
}

type SignalingInbound = SignalingAnswer | SignalingIce;

/**
 * WebSocket signaling client for /webrtc-signal. Mirrors the browser's
 * RTCSession exchange in apps/novnc/vnc/www/core/rtc-session.js — three JSON
 * message types (offer outbound, answer inbound, ice both directions).
 *
 * Events: 'open' (), 'answer' (SignalingAnswer), 'ice' (IceCandidateInit),
 * 'close' (), 'error' (Error). Untyped via EventEmitter to keep the class
 * declaration biome-clean — callers know the shapes from this module.
 */
export class Signaling extends EventEmitter {
	private ws: WebSocket;
	private opened = false;

	constructor(url: string) {
		super();
		this.ws = new WebSocket(url, {
			rejectUnauthorized: false,
			headers: { Origin: new URL(url).origin },
		});

		this.ws.on('open', () => {
			this.opened = true;
			this.emit('open');
		});

		this.ws.on('message', (data: Buffer | string) => {
			let msg: SignalingInbound;
			try {
				msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
			} catch (err) {
				this.emit(
					'error',
					new RtcSignalingError(
						`Malformed signaling message: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
				return;
			}
			if (msg.type === 'answer') {
				this.emit('answer', msg);
			} else if (msg.type === 'ice' && msg.candidate) {
				this.emit('ice', msg.candidate);
			}
		});

		this.ws.on('error', (err: Error) => {
			this.emit('error', new RtcConnectionError(`Signaling WebSocket error: ${err.message}`));
		});

		this.ws.on('close', () => {
			this.emit('close');
		});
	}

	sendOffer(sdp: string): void {
		this.send({ type: 'offer', sdp });
	}

	sendIce(candidate: IceCandidateInit): void {
		this.send({ type: 'ice', candidate });
	}

	private send(payload: unknown): void {
		if (!this.opened || this.ws.readyState !== WebSocket.OPEN) {
			throw new RtcSignalingError('Signaling channel is not open');
		}
		this.ws.send(JSON.stringify(payload));
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// ignore
		}
	}
}

export function openSignaling(url: string, timeoutMs: number): Promise<Signaling> {
	return new Promise<Signaling>((resolve, reject) => {
		const sig = new Signaling(url);
		const timeout = setTimeout(() => {
			sig.close();
			reject(new RtcConnectionError(`Signaling connect timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		sig.once('open', () => {
			clearTimeout(timeout);
			resolve(sig);
		});

		sig.once('error', (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}
