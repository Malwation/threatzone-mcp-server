import type { DeviceButton } from '../../shared/remote-session.js';
import { RtcConnectionError } from '../errors.js';

/**
 * Minimal data-channel surface we rely on. The DOM RTCDataChannel type isn't
 * loaded in this project's tsconfig — defining the shape locally keeps the
 * control-channel module typed without requiring lib.dom.
 */
export interface DataChannelLike {
	readyState: 'connecting' | 'open' | 'closing' | 'closed';
	send(data: string): void;
}

type Action = 'down' | 'up' | 'move';
type KeyAction = 'down' | 'up';

/**
 * JSON encoder for the "control" data channel. Wire format mirrors
 * apps/novnc/vnc/www/core/rtc-session.js: every input event is a single JSON
 * message with a `type` discriminator. Coordinates are normalized [0..1] —
 * the caller is responsible for converting from pixel space.
 */
export class ControlChannel {
	constructor(private readonly dc: DataChannelLike) {}

	sendTouch(action: Action, x: number, y: number): void {
		this.send({ type: 'touch', action, x: clamp01(x), y: clamp01(y) });
	}

	sendKey(action: KeyAction, code: string): void {
		this.send({ type: 'key', action, code });
	}

	sendScroll(x: number, y: number, dx: number, dy: number): void {
		this.send({
			type: 'scroll',
			x: clamp01(x),
			y: clamp01(y),
			dx: clampPm1(dx),
			dy: clampPm1(dy),
		});
	}

	sendDeviceButton(button: DeviceButton): void {
		const payload = { type: button };
		// Logged so an operator can correlate MCP-side intent with gateway logs.
		// device_button effectiveness depends on whether the gateway routes these
		// to actual KEYCODEs on the device — see CLAUDE.md landmines.
		console.error(`[rtc][ctrl] device_button: ${JSON.stringify(payload)}`);
		this.send(payload);
	}

	sendClipboard(text: string, paste = true): void {
		// Mirrors apps/novnc/vnc/www/core/rtc-session.js:419. paste=true makes the
		// gateway's scrcpy auto-inject a paste keystroke after setting the device
		// clipboard, which matches the browser's Cmd/Ctrl+V intercept behavior.
		this.send({ type: 'clipboard', text, paste });
	}

	private send(payload: unknown): void {
		if (this.dc.readyState !== 'open') {
			throw new RtcConnectionError(`Control channel is not open (state: ${this.dc.readyState})`);
		}
		this.dc.send(JSON.stringify(payload));
	}
}

function clamp01(v: number): number {
	if (Number.isNaN(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

function clampPm1(v: number): number {
	if (Number.isNaN(v)) return 0;
	if (v < -1) return -1;
	if (v > 1) return 1;
	return v;
}
