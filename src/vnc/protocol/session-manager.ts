import { randomUUID } from 'node:crypto';
import type { RemoteSession } from '../../shared/remote-session.js';
import { SessionNotFoundError } from '../errors.js';
import type { SessionInfo, VncSessionConfig } from './protocol-types.js';
import { VncClient } from './vnc-client.js';

export class SessionManager {
	private sessions = new Map<string, RemoteSession>();
	private defaultSessionId: string | null = null;

	/** Construct + connect a VncClient and register it. */
	async connectVnc(
		config: Omit<VncSessionConfig, 'sessionId'> & { sessionId?: string },
	): Promise<VncClient> {
		const sessionId = config.sessionId ?? randomUUID();
		const fullConfig: VncSessionConfig = { ...config, sessionId };

		const client = new VncClient(fullConfig, {
			connectTimeout: Number(process.env.VNC_CONNECT_TIMEOUT) || 10000,
			screenshotTimeout: Number(process.env.VNC_SCREENSHOT_TIMEOUT) || 5000,
		});

		await client.connect();
		this.register(client);
		return client;
	}

	/**
	 * Register an already-connected session. Used by the connect tool's RTC
	 * branch (RtcClient is constructed there because it needs transport-specific
	 * config like signalingUrl that doesn't fit the VncSessionConfig shape).
	 */
	register(client: RemoteSession): void {
		this.sessions.set(client.config.sessionId, client);
		this.defaultSessionId = client.config.sessionId;
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

	getSession(sessionId?: string): RemoteSession {
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
