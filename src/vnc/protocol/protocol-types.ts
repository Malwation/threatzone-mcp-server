export interface VncSessionConfig {
	host: string;
	port: number;
	username?: string;
	password?: string;
	wsUrl?: string;
	wsHeaders?: Record<string, string>;
	sessionId: string;
}

export type VncSessionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ScreenSize {
	width: number;
	height: number;
}

export interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FramebufferRect {
	x: number;
	y: number;
	width: number;
	height: number;
	encoding: number;
	data: Buffer;
}

export interface PixelFormat {
	bitsPerPixel: number;
	depth: number;
	bigEndianFlag: number;
	trueColourFlag: number;
	redMax: number;
	greenMax: number;
	blueMax: number;
	redShift: number;
	greenShift: number;
	blueShift: number;
}

export interface SessionInfo {
	sessionId: string;
	state: VncSessionState;
	screenSize: ScreenSize | null;
	host: string;
	port: number;
}

export type ImageFormat = 'png' | 'jpeg';

export const BUTTON_MASK = {
	left: 1,
	middle: 2,
	right: 4,
	scrollUp: 8,
	scrollDown: 16,
	scrollLeft: 32,
	scrollRight: 64,
} as const;

export const SCROLL_DIRECTION_MASK: Record<string, number> = {
	up: BUTTON_MASK.scrollUp,
	down: BUTTON_MASK.scrollDown,
	left: BUTTON_MASK.scrollLeft,
	right: BUTTON_MASK.scrollRight,
};
