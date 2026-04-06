import { EventEmitter } from 'node:events';
import { createConnection, encodings, type RfbClient } from 'rfb2';

/* ------------------------------------------------------------------ */
/*  Shared backend interface                                           */
/* ------------------------------------------------------------------ */

export interface RfbRect {
	x: number;
	y: number;
	width: number;
	height: number;
	encoding: number;
	data: Buffer;
	buffer: Buffer;
}

export interface RfbBackend extends EventEmitter {
	/* screen geometry & pixel format */
	width: number;
	height: number;
	bpp: number;
	redShift: number;
	greenShift: number;
	blueShift: number;

	/* RFB operations */
	requestUpdate(incremental: boolean, x: number, y: number, w: number, h: number): void;
	keyEvent(keysym: number, down: number): void;
	pointerEvent(x: number, y: number, buttonMask: number): void;
	clientCutText(text: string): void;
	end(): void;
}

/* ------------------------------------------------------------------ */
/*  rfb2 adapter – wraps the legacy library behind RfbBackend          */
/* ------------------------------------------------------------------ */

export interface Rfb2ConnectOptions {
	host: string;
	port: number;
	password?: string;
}

/**
 * Wraps rfb2's `createConnection` result so it satisfies `RfbBackend`.
 * The underlying RfbClient already extends EventEmitter so events
 * (connect, error, end, rect, resize) are forwarded transparently.
 */
export function createRfb2Backend(options: Rfb2ConnectOptions): RfbBackend {
	const client: RfbClient = createConnection({
		host: options.host,
		port: options.port,
		password: options.password,
		encodings: [encodings.raw, encodings.copyRect, encodings.pseudoDesktopSize],
	});

	// rfb2's RfbClient already has width/height/bpp/redShift/etc. as
	// instance properties set during ServerInit, plus the EventEmitter
	// methods. Cast is safe because the shape matches after 'connect'.

	// Bridge rfb2's updateClipboard to our clientCutText interface
	const backend = client as unknown as RfbBackend;
	backend.clientCutText = (
		client as unknown as { updateClipboard(text: string): void }
	).updateClipboard.bind(client);
	return backend;
}

export { encodings } from 'rfb2';
