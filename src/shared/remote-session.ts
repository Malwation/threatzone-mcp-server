export type RemoteSessionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export type RemoteTransport = 'vnc' | 'rtc';

export type ImageFormat = 'png' | 'jpeg';

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

export type DeviceButton = 'back' | 'home' | 'power';

export interface RemoteSessionConfig {
	sessionId: string;
	host: string;
	port: number;
}

/**
 * Common surface implemented by VncClient and RtcClient. Tool handlers consume
 * sessions via this interface so they don't need to know which transport is
 * active. Methods that only apply to one transport (clipboard on RTC,
 * device_button on VNC) throw UnsupportedOnTransportError on the other side.
 */
export interface RemoteSession {
	readonly transport: RemoteTransport;
	readonly config: RemoteSessionConfig;
	readonly state: RemoteSessionState;
	readonly screenSize: ScreenSize | null;

	connect(): Promise<void>;
	disconnect(): void;

	screenshot(format?: ImageFormat, region?: Region, quality?: number): Promise<Buffer>;
	waitForRect(timeoutMs: number): Promise<boolean>;

	sendKey(keysym: number, down: boolean): void;
	sendPointer(x: number, y: number, buttonMask: number): void;
	sendDeviceButton(button: DeviceButton): void;

	updateClipboard(text: string): void;
	getClipboard(): string | null;

	requestFramebufferUpdate(incremental: boolean): void;
}
