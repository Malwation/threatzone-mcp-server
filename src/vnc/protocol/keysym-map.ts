/**
 * Maps human-readable key names to X11 keysyms.
 * Sourced from noVNC's core/input/keysym.js (XK_* constants).
 */

const MODIFIER_KEYSYMS: Record<string, number> = {
	ctrl: 0xffe3,
	control: 0xffe3,
	alt: 0xffe9,
	shift: 0xffe1,
	super: 0xffeb,
	// `meta` aliases to Super_L (0xffeb), NOT Meta_L (0xffe7). On macOS the
	// Cmd key is the de-facto Super_L; on Linux DEs Super_L is the Win/Cmd
	// key too. Meta_L (0xffe7) has no physical key on most modern keyboards
	// and silently produces no action when sent to a typical VNC server.
	meta: 0xffeb,
};

const KEY_MAP: Record<string, number> = {
	// Editing keys
	BackSpace: 0xff08,
	Tab: 0xff09,
	Linefeed: 0xff0a,
	Clear: 0xff0b,
	Return: 0xff0d,
	Enter: 0xff0d,
	Pause: 0xff13,
	Scroll_Lock: 0xff14,
	Sys_Req: 0xff15,
	Escape: 0xff1b,
	Delete: 0xffff,
	Insert: 0xff63,

	// Cursor control
	Home: 0xff50,
	Left: 0xff51,
	Up: 0xff52,
	Right: 0xff53,
	Down: 0xff54,
	Page_Up: 0xff55,
	Page_Down: 0xff56,
	End: 0xff57,

	// Misc functions
	Select: 0xff60,
	Print: 0xff61,
	Execute: 0xff62,
	Undo: 0xff65,
	Redo: 0xff66,
	Menu: 0xff67,
	Find: 0xff68,
	Cancel: 0xff69,
	Help: 0xff6a,
	Break: 0xff6b,
	Num_Lock: 0xff7f,

	// Function keys
	F1: 0xffbe,
	F2: 0xffbf,
	F3: 0xffc0,
	F4: 0xffc1,
	F5: 0xffc2,
	F6: 0xffc3,
	F7: 0xffc4,
	F8: 0xffc5,
	F9: 0xffc6,
	F10: 0xffc7,
	F11: 0xffc8,
	F12: 0xffc9,

	// Modifiers
	Shift_L: 0xffe1,
	Shift_R: 0xffe2,
	Control_L: 0xffe3,
	Control_R: 0xffe4,
	Caps_Lock: 0xffe5,
	// Meta_L/Meta_R aliased to Super_L/Super_R for consistency with the
	// `meta` modifier alias (most VNC servers map Cmd/Win to Super_L).
	Meta_L: 0xffeb,
	Meta_R: 0xffec,
	Alt_L: 0xffe9,
	Alt_R: 0xffea,
	Super_L: 0xffeb,
	Super_R: 0xffec,

	// Keypad
	KP_Enter: 0xff8d,
	KP_Home: 0xff95,
	KP_Left: 0xff96,
	KP_Up: 0xff97,
	KP_Right: 0xff98,
	KP_Down: 0xff99,
	KP_Page_Up: 0xff9a,
	KP_Page_Down: 0xff9b,
	KP_End: 0xff9c,
	KP_Insert: 0xff9e,
	KP_Delete: 0xff9f,
	KP_Multiply: 0xffaa,
	KP_Add: 0xffab,
	KP_Subtract: 0xffad,
	KP_Decimal: 0xffae,
	KP_Divide: 0xffaf,
	KP_0: 0xffb0,
	KP_1: 0xffb1,
	KP_2: 0xffb2,
	KP_3: 0xffb3,
	KP_4: 0xffb4,
	KP_5: 0xffb5,
	KP_6: 0xffb6,
	KP_7: 0xffb7,
	KP_8: 0xffb8,
	KP_9: 0xffb9,

	// Common aliases (case-insensitive lookup handles these too)
	Space: 0x0020,
};

// Build a case-insensitive lookup
const CASE_INSENSITIVE_MAP = new Map<string, number>();
for (const [key, value] of Object.entries(KEY_MAP)) {
	CASE_INSENSITIVE_MAP.set(key.toLowerCase(), value);
}
for (const [key, value] of Object.entries(MODIFIER_KEYSYMS)) {
	CASE_INSENSITIVE_MAP.set(key.toLowerCase(), value);
}

export function resolveKeysym(key: string): number {
	// Direct lookup (case-sensitive first)
	if (key in KEY_MAP) {
		return KEY_MAP[key];
	}

	// Case-insensitive lookup
	const lower = key.toLowerCase();
	const fromMap = CASE_INSENSITIVE_MAP.get(lower);
	if (fromMap !== undefined) {
		return fromMap;
	}

	// Hex keysym (e.g., "0xff0d")
	if (key.startsWith('0x') || key.startsWith('0X')) {
		const parsed = Number.parseInt(key, 16);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}

	// Single printable ASCII character (U+0020 to U+007E) — keysym equals codepoint
	if (key.length === 1) {
		const code = key.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) {
			return code;
		}
		// Unicode character — X11 keysym is 0x01000000 + Unicode codepoint
		if (code > 0x7e) {
			return 0x01000000 + code;
		}
	}

	throw new Error(`Cannot resolve key '${key}' to an X11 keysym`);
}

export function resolveModifierKeysym(modifier: string): number {
	const lower = modifier.toLowerCase();
	const keysym = MODIFIER_KEYSYMS[lower];
	if (keysym === undefined) {
		throw new Error(
			`Unknown modifier '${modifier}'. Valid modifiers: ${Object.keys(MODIFIER_KEYSYMS).join(', ')}`,
		);
	}
	return keysym;
}
