import { McpToolError } from '../shared/errors.js';

export class RtcError extends McpToolError {
	constructor(message: string, code: string) {
		super(message, code);
		this.name = 'RtcError';
	}
}

export class RtcConnectionError extends RtcError {
	constructor(message: string) {
		super(message, 'RTC_CONNECTION_ERROR');
		this.name = 'RtcConnectionError';
	}
}

export class RtcSignalingError extends RtcError {
	constructor(message: string) {
		super(message, 'RTC_SIGNALING_ERROR');
		this.name = 'RtcSignalingError';
	}
}

/**
 * Thrown when a tool calls a method that doesn't apply to the active session's
 * transport — e.g. clipboard_read on an RTC session, or device_button on a VNC
 * session. The browser RTCSession likewise has no clipboard/file support, and
 * VNC has no notion of Android device buttons.
 */
export class UnsupportedOnTransportError extends RtcError {
	constructor(transport: string, op: string) {
		super(`${transport} transport does not support ${op}`, 'UNSUPPORTED_ON_TRANSPORT');
		this.name = 'UnsupportedOnTransportError';
	}
}

/**
 * Thrown by the H.264 decoder when ffmpeg can't decode because the GOP buffer
 * lacks the SPS/PPS that the IDR slice references. RtcClient catches this and
 * retries once after sending a PLI to force a fresh keyframe with parameters.
 */
export class MissingParameterSetsError extends RtcError {
	constructor(message: string) {
		super(message, 'MISSING_PARAMETER_SETS');
		this.name = 'MissingParameterSetsError';
	}
}
