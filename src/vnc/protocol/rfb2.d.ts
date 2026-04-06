import 'rfb2';

declare module 'rfb2' {
	interface RfbClient {
		bpp: number;
		depth: number;
		isBigEndian: number;
		isTrueColor: number;
		redMax: number;
		greenMax: number;
		blueMax: number;
		redShift: number;
		greenShift: number;
		blueShift: number;
		title: string;

		keyEvent(keysym: number, isDown: number): void;
		pointerEvent(x: number, y: number, buttons: number): void;
	}
}
