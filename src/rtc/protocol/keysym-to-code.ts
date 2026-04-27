/**
 * Reverse map from X11 keysym → DOM `KeyboardEvent.code`. The Android gateway
 * expects layout-agnostic physical-key codes (KeyA, Digit1, ShiftLeft…), so we
 * translate from the keysym space the rest of the MCP server uses.
 *
 * For ASCII printables that require Shift on a US layout (uppercase letters,
 * `!`, `@`, etc.), `shifted: true` is returned so the caller (RtcClient) can
 * wrap the key event with synthetic ShiftLeft press/release. This keeps
 * `type_text` working for mixed-case strings and common punctuation without
 * the caller having to explicitly send shift modifiers.
 */

export interface CodeMapping {
	code: string;
	shifted?: boolean;
}

/** Keys not in this map return null and are dropped with a stderr warning. */
const KEYSYM_TO_CODE: Record<number, CodeMapping> = (() => {
	const m: Record<number, CodeMapping> = {};

	// Letters a–z → KeyA–KeyZ (unshifted)
	for (let i = 0; i < 26; i++) {
		m[0x61 + i] = { code: `Key${String.fromCharCode(0x41 + i)}` };
	}
	// Letters A–Z → KeyA–KeyZ (shifted)
	for (let i = 0; i < 26; i++) {
		m[0x41 + i] = { code: `Key${String.fromCharCode(0x41 + i)}`, shifted: true };
	}
	// Digits 0–9 → Digit0–Digit9 (unshifted)
	for (let i = 0; i < 10; i++) {
		m[0x30 + i] = { code: `Digit${i}` };
	}

	// Punctuation — US-layout physical-key mapping
	const punct: Array<[number, string, boolean?]> = [
		[0x20, 'Space'],
		[0x21, 'Digit1', true], // !
		[0x22, 'Quote', true], // "
		[0x23, 'Digit3', true], // #
		[0x24, 'Digit4', true], // $
		[0x25, 'Digit5', true], // %
		[0x26, 'Digit7', true], // &
		[0x27, 'Quote'], // '
		[0x28, 'Digit9', true], // (
		[0x29, 'Digit0', true], // )
		[0x2a, 'Digit8', true], // *
		[0x2b, 'Equal', true], // +
		[0x2c, 'Comma'], // ,
		[0x2d, 'Minus'], // -
		[0x2e, 'Period'], // .
		[0x2f, 'Slash'], // /
		[0x3a, 'Semicolon', true], // :
		[0x3b, 'Semicolon'], // ;
		[0x3c, 'Comma', true], // <
		[0x3d, 'Equal'], // =
		[0x3e, 'Period', true], // >
		[0x3f, 'Slash', true], // ?
		[0x40, 'Digit2', true], // @
		[0x5b, 'BracketLeft'], // [
		[0x5c, 'Backslash'], // \
		[0x5d, 'BracketRight'], // ]
		[0x5e, 'Digit6', true], // ^
		[0x5f, 'Minus', true], // _
		[0x60, 'Backquote'], // `
		[0x7b, 'BracketLeft', true], // {
		[0x7c, 'Backslash', true], // |
		[0x7d, 'BracketRight', true], // }
		[0x7e, 'Backquote', true], // ~
	];
	for (const [keysym, code, shifted] of punct) {
		m[keysym] = shifted ? { code, shifted: true } : { code };
	}

	// Editing / control keys (X11 keysyms from src/vnc/protocol/keysym-map.ts)
	m[0xff08] = { code: 'Backspace' };
	m[0xff09] = { code: 'Tab' };
	m[0xff0d] = { code: 'Enter' };
	m[0xff13] = { code: 'Pause' };
	m[0xff14] = { code: 'ScrollLock' };
	m[0xff1b] = { code: 'Escape' };
	m[0xffff] = { code: 'Delete' };
	m[0xff63] = { code: 'Insert' };

	// Cursor control
	m[0xff50] = { code: 'Home' };
	m[0xff51] = { code: 'ArrowLeft' };
	m[0xff52] = { code: 'ArrowUp' };
	m[0xff53] = { code: 'ArrowRight' };
	m[0xff54] = { code: 'ArrowDown' };
	m[0xff55] = { code: 'PageUp' };
	m[0xff56] = { code: 'PageDown' };
	m[0xff57] = { code: 'End' };

	m[0xff7f] = { code: 'NumLock' };

	// Function keys F1–F12
	for (let i = 0; i < 12; i++) {
		m[0xffbe + i] = { code: `F${i + 1}` };
	}

	// Modifiers
	m[0xffe1] = { code: 'ShiftLeft' };
	m[0xffe2] = { code: 'ShiftRight' };
	m[0xffe3] = { code: 'ControlLeft' };
	m[0xffe4] = { code: 'ControlRight' };
	m[0xffe5] = { code: 'CapsLock' };
	m[0xffe7] = { code: 'MetaLeft' };
	m[0xffe8] = { code: 'MetaRight' };
	m[0xffe9] = { code: 'AltLeft' };
	m[0xffea] = { code: 'AltRight' };
	m[0xffeb] = { code: 'MetaLeft' }; // Super_L → Meta on most platforms
	m[0xffec] = { code: 'MetaRight' };

	// Numpad (no shift behavior — gateway likely treats the same as cursor keys)
	m[0xff8d] = { code: 'NumpadEnter' };
	m[0xffaa] = { code: 'NumpadMultiply' };
	m[0xffab] = { code: 'NumpadAdd' };
	m[0xffad] = { code: 'NumpadSubtract' };
	m[0xffae] = { code: 'NumpadDecimal' };
	m[0xffaf] = { code: 'NumpadDivide' };
	for (let i = 0; i < 10; i++) {
		m[0xffb0 + i] = { code: `Numpad${i}` };
	}

	return m;
})();

export function keysymToCode(keysym: number): CodeMapping | null {
	return KEYSYM_TO_CODE[keysym] ?? null;
}

export const SHIFT_LEFT_KEYSYM = 0xffe1;
