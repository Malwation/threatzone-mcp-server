import { randomUUID } from 'node:crypto';
import { SessionNotFoundError } from '../errors.js';
import type { SessionInfo, VncSessionConfig } from './protocol-types.js';
import { VncClient } from './vnc-client.js';

export class SessionManager {
	private sessions = new Map<string, VncClient>();
	private defaultSessionId: string | null = null;

	async connect(
		config: Omit<VncSessionConfig, 'sessionId'> & { sessionId?: string },
	): Promise<VncClient> {
		const sessionId = config.sessionId ?? randomUUID();
		const fullConfig: VncSessionConfig = { ...config, sessionId };

		const client = new VncClient(fullConfig, {
			connectTimeout: Number(process.env.VNC_CONNECT_TIMEOUT) || 10000,
			screenshotTimeout: Number(process.env.VNC_SCREENSHOT_TIMEOUT) || 5000,
		});

		await client.connect();
		this.sessions.set(sessionId, client);
		this.defaultSessionId = sessionId;
		return client;
	}

	disconnect(sessionId?: string): void {
		const id = sessionId ?? this.defaultSessionId;
		if (!id) throw new SessionNotFoundError();

		const client = this.sessions.get(id);
		if (!client) throw new SessionNotFoundError(id);

		client.disconnect();
		this.sessions.delete(id);

		if (this.defaultSessionId === id) {
			// Set default to the most recent remaining session, if any
			const keys = [...this.sessions.keys()];
			this.defaultSessionId = keys.length > 0 ? keys[keys.length - 1] : null;
		}
	}

	getSession(sessionId?: string): VncClient {
		const id = sessionId ?? this.defaultSessionId;
		if (!id) throw new SessionNotFoundError();

		const client = this.sessions.get(id);
		if (!client) throw new SessionNotFoundError(id);

		return client;
	}

	listSessions(): SessionInfo[] {
		return [...this.sessions.entries()].map(([id, client]) => ({
			sessionId: id,
			state: client.state,
			screenSize: client.screenSize,
			host: client.config.host,
			port: client.config.port,
		}));
	}

	disconnectAll(): void {
		for (const client of this.sessions.values()) {
			client.disconnect();
		}
		this.sessions.clear();
		this.defaultSessionId = null;
	}
}
