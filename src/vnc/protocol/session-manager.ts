import { randomUUID } from 'node:crypto';
import type { RemoteSession } from '../../shared/remote-session.js';
import type { TransportMode } from '../../shared/tool-context.js';
import { SessionNotFoundError } from '../errors.js';
import type { SessionInfo, VncSessionConfig } from './protocol-types.js';
import { VncClient } from './vnc-client.js';

/** HTTP mode closes a session after this long with no tool call on it. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const HTTP_SESSION_NOT_FOUND =
	'Session not found or ended. Call "connect" with submission_uuid to get a session_id.';

export interface SessionManagerOptions {
	/** stdio: tools may omit session_id and use the last connected session. Default true. */
	defaultSession?: boolean;
	/** Close a session after this many ms with no tool call. null (default) disables it. */
	idleTimeoutMs?: number | null;
	/** Builds the client for a new session. Tests inject a fake. */
	createClient?: (config: VncSessionConfig) => RemoteSession;
}

interface SessionEntry {
	client: RemoteSession;
	idleTimer: NodeJS.Timeout | undefined;
}

function createVncClient(config: VncSessionConfig): RemoteSession {
	return new VncClient(config, {
		connectTimeout: Number(process.env.VNC_CONNECT_TIMEOUT) || 10000,
		screenshotTimeout: Number(process.env.VNC_SCREENSHOT_TIMEOUT) || 5000,
	});
}

export class SessionManager {
	private sessions = new Map<string, SessionEntry>();
	private pending = new Map<string, Promise<RemoteSession>>();
	private defaultSessionId: string | null = null;
	private readonly allowDefault: boolean;
	private readonly idleTimeoutMs: number | null;
	private readonly createClient: (config: VncSessionConfig) => RemoteSession;

	constructor(options: SessionManagerOptions = {}) {
		this.allowDefault = options.defaultSession ?? true;
		this.idleTimeoutMs = options.idleTimeoutMs ?? null;
		this.createClient = options.createClient ?? createVncClient;
	}

	/** HTTP mode: no default session and a 5-minute idle timeout. stdio mode: as before. */
	static forTransport(mode: TransportMode): SessionManager {
		return mode === 'http'
			? new SessionManager({ defaultSession: false, idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS })
			: new SessionManager();
	}

	/** Construct + connect a client and register it. */
	async connectVnc(
		config: Omit<VncSessionConfig, 'sessionId'> & { sessionId?: string },
	): Promise<RemoteSession> {
		const sessionId = config.sessionId ?? randomUUID();
		const client = this.createClient({ ...config, sessionId });
		await client.connect();
		this.register(client);
		return client;
	}

	/**
	 * Returns the connected session with this ID, or dials a new one. Concurrent calls for the
	 * same ID share one dial. A dead session with this ID is replaced.
	 */
	async connectOrReuse(
		config: VncSessionConfig,
	): Promise<{ client: RemoteSession; reused: boolean }> {
		const id = config.sessionId;
		const live = this.liveEntry(id);
		if (live) {
			this.touch(id, live);
			return { client: live.client, reused: true };
		}
		const inFlight = this.pending.get(id);
		if (inFlight) return { client: await inFlight, reused: true };

		const dial = this.connectVnc(config).finally(() => this.pending.delete(id));
		this.pending.set(id, dial);
		return { client: await dial, reused: false };
	}

	/** Register a connected session and make it the default. An old client with the same ID is disconnected. */
	register(client: RemoteSession): void {
		const id = client.config.sessionId;
		const old = this.sessions.get(id);
		if (old && old.client !== client) this.drop(id);

		const entry: SessionEntry = { client, idleTimer: undefined };
		this.sessions.set(id, entry);
		this.defaultSessionId = id;
		client.onClose(() => {
			if (this.sessions.get(id) === entry) this.drop(id);
		});
		this.touch(id, entry);
	}

	disconnect(sessionId?: string): void {
		const id = this.resolveId(sessionId);
		if (!this.sessions.has(id)) throw this.notFound(id);
		this.drop(id);
	}

	getSession(sessionId?: string): RemoteSession {
		const id = this.resolveId(sessionId);
		const entry = this.liveEntry(id);
		if (!entry) throw this.notFound(id);
		this.touch(id, entry);
		return entry.client;
	}

	listSessions(): SessionInfo[] {
		return [...this.sessions.entries()].map(([id, { client }]) => ({
			sessionId: id,
			state: client.state,
			screenSize: client.screenSize,
			host: client.config.host,
			port: client.config.port,
		}));
	}

	disconnectAll(): void {
		for (const id of [...this.sessions.keys()]) this.drop(id);
		this.defaultSessionId = null;
	}

	private resolveId(sessionId: string | undefined): string {
		const id = sessionId ?? (this.allowDefault ? this.defaultSessionId : null);
		if (!id) throw this.notFound();
		return id;
	}

	private notFound(id?: string): SessionNotFoundError {
		return this.allowDefault
			? new SessionNotFoundError(id)
			: new SessionNotFoundError(id, HTTP_SESSION_NOT_FOUND);
	}

	// Returns the entry only while its client is connected. A dead entry is removed.
	private liveEntry(id: string): SessionEntry | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		if (entry.client.state === 'connected') return entry;
		this.drop(id);
		return undefined;
	}

	private touch(id: string, entry: SessionEntry): void {
		if (this.idleTimeoutMs === null) return;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => {
			if (this.sessions.get(id) === entry) this.drop(id);
		}, this.idleTimeoutMs);
		entry.idleTimer.unref?.();
	}

	// Removes the entry before disconnecting, so the client's close event finds nothing to remove.
	private drop(id: string): void {
		const entry = this.sessions.get(id);
		if (!entry) return;
		clearTimeout(entry.idleTimer);
		this.sessions.delete(id);
		if (this.defaultSessionId === id) {
			const keys = [...this.sessions.keys()];
			this.defaultSessionId = keys.length > 0 ? keys[keys.length - 1] : null;
		}
		entry.client.disconnect();
	}
}
