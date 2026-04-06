import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveKeysym, resolveModifierKeysym } from '../protocol/keysym-map.js';
import type { SessionManager } from '../protocol/session-manager.js';

export interface SendKeyArgs {
	key: string;
	down?: boolean;
	modifiers?: string[];
	session_id?: string;
}

export function handleSendKey(args: SendKeyArgs, sessionManager: SessionManager): CallToolResult {
	const client = sessionManager.getSession(args.session_id);
	const keysym = resolveKeysym(args.key);
	const modifierKeysyms = (args.modifiers ?? []).map(resolveModifierKeysym);

	// Press modifiers
	for (const mod of modifierKeysyms) {
		client.sendKey(mod, true);
	}

	// Send the key
	if (args.down === undefined) {
		// Press and release
		client.sendKey(keysym, true);
		client.sendKey(keysym, false);
	} else {
		client.sendKey(keysym, args.down);
	}

	// Release modifiers in reverse order
	for (let i = modifierKeysyms.length - 1; i >= 0; i--) {
		client.sendKey(modifierKeysyms[i], false);
	}

	const modStr = args.modifiers?.length ? ` with modifiers [${args.modifiers.join(', ')}]` : '';
	return {
		content: [{ type: 'text', text: `Sent key '${args.key}'${modStr}` }],
	};
}
