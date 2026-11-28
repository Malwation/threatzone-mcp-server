import { randomUUID } from 'node:crypto';
import type { RemoteSession } from '../../shared/remote-session.js';
import type { TransportMode } from '../../shared/tool-context.js';
import { LiveViewEndedError, SessionNotFoundError } from '../errors.js';
import type { SessionInfo, VncSessionConfig } from './protocol-types.js';
import { redactMessage } from './redact.js';
import { VncClient } from './vnc-client.js';

/** HTTP mode closes the connection of a session after this long with no tool call on it. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Both modes drop a disconnected session after this long with no tool call (frees the stored link). */
export const SESSION_STALE_TIMEOUT_MS = 30 * 60 * 1000;

const HTTP_SESSION_NOT_FOUND =
	'Session not found or ended. Call "connect" with submission_uuid to get a session_id.';

export interface SessionManagerOptions {
	/** stdio: tools may omit session_id and use the last connected session. Default true. */
	defaultSession?: boolean;
	/** Close the connection after this many ms with no tool call. null (default) disables it. */
	idleTimeoutMs?: number | null;
	/** Drop a disconnected session after this many ms with no tool call. */
	staleTimeoutMs?: number;
	/** Builds the client for a dial. Tests inject a fake. */
	createClient?: (config: VncSessionConfig) => RemoteSession;
}

/**
 * One named session. It keeps its dial config, so a closed connection can be dialed again on the
 * next tool call. `client` is the latest connection; `live` is false after a close.
 */
interface SessionEntry {
	config: VncSessionConfig;
	client: RemoteSession;
	live: boolean;
	inFlight: number;
	timer: NodeJS.Timeout | undefined;
	redial: Promise<RemoteSession> | undefined;
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
	private readonly staleTimeoutMs: number;
	private readonly createClient: (config: VncSessionConfig) => RemoteSession;

	constructor(options: SessionManagerOptions = {}) {
		this.allowDefault = options.defaultSession ?? true;
		this.idleTimeoutMs = options.idleTimeoutMs ?? null;
		this.staleTimeoutMs = options.staleTimeoutMs ?? SESSION_STALE_TIMEOUT_MS;
		this.createClient = options.createClient ?? createVncClient;
	}

	/** HTTP mode: no default session and a 5-minute idle timeout. stdio mode: as before. */
	static forTransport(mode: TransportMode): SessionManager {
		return mode === 'http'
			? new SessionManager({ defaultSession: false, idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS })
			: new SessionManager();
	}

	/** Dial a new session and register it. An old session with the same ID is closed. */
	async connectVnc(
		config: Omit<VncSessionConfig, 'sessionId'> & { sessionId?: string },
	): Promise<RemoteSession> {
		const fullConfig: VncSessionConfig = { ...config, sessionId: config.sessionId ?? randomUUID() };
		const client = await this.dial(fullConfig);
		this.register(client, fullConfig);
		return client;
	}

	/**
	 * Returns the connected session with this ID, or dials it. Concurrent calls for the same ID share
	 * one dial. A disconnected session with this ID is dialed again with the new config.
	 */
	async connectOrReuse(
		config: VncSessionConfig,
	): Promise<{ client: RemoteSession; reused: boolean }> {
		const id = config.sessionId;
		const entry = this.sessions.get(id);
		if (entry) {
			if (this.isLive(entry)) {
				this.touch(id, entry);
				return { client: entry.client, reused: true };
			}
			if (entry.redial) return { client: await entry.redial, reused: true };
			entry.config = config;
			return { client: await this.redial(id, entry), reused: false };
		}
		const inFlight = this.pending.get(id);
		if (inFlight) return { client: await inFlight, reused: true };

		const dial = this.connectVnc(config).finally(() => this.pending.delete(id));
		this.pending.set(id, dial);
		return { client: await dial, reused: false };
	}

	/** Register a connected session and make it the default. An old client with the same ID is closed. */
	register(client: RemoteSession, config: VncSessionConfig): void {
		const id = client.config.sessionId;
		if (this.sessions.get(id)?.client === client) return;
		this.drop(id);

		const entry: SessionEntry = {
			config,
			client,
			live: true,
			inFlight: 0,
			timer: undefined,
			redial: undefined,
		};
		this.sessions.set(id, entry);
		this.defaultSessionId = id;
		this.watch(id, entry, client);
		this.touch(id, entry);
	}

	/**
	 * Runs one tool call on a session. A closed connection is dialed again first (one dial shared
	 * by concurrent calls). The idle timeout never closes a session while a call runs on it.
	 */
	async run<T>(
		sessionId: string | undefined,
		fn: (client: RemoteSession) => T | Promise<T>,
	): Promise<T> {
		const id = this.resolveId(sessionId);
		const entry = this.sessions.get(id);
		if (!entry) throw this.notFound(id);

		entry.inFlight++;
		try {
			const client = this.isLive(entry) ? entry.client : await this.redialForCall(id, entry);
			this.touch(id, entry);
			return await fn(client);
		} finally {
			entry.inFlight--;
			if (this.sessions.get(id) === entry) this.touch(id, entry);
		}
	}

	disconnect(sessionId?: string): void {
		const id = this.resolveId(sessionId);
		if (!this.sessions.has(id)) throw this.notFound(id);
		this.drop(id, true);
	}

	/** The current connection of a session. Tool handlers call it inside `run`. */
	getSession(sessionId?: string): RemoteSession {
		const id = this.resolveId(sessionId);
		const entry = this.sessions.get(id);
		if (!entry) throw this.notFound(id);
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

	private async dial(config: VncSessionConfig): Promise<RemoteSession> {
		const client = this.createClient(config);
		await client.connect();
		return client;
	}

	private redial(id: string, entry: SessionEntry): Promise<RemoteSession> {
		entry.redial ??= this.dial(entry.config)
			.then((client) => {
				if (this.sessions.get(id) !== entry) {
					// Removed while dialing (disconnect or shutdown): do not keep the new socket.
					client.disconnect();
					throw this.notFound(id);
				}
				entry.client = client;
				entry.live = true;
				this.watch(id, entry, client);
				return client;
			})
			.catch((err: unknown) => {
				if (this.sessions.get(id) === entry) this.drop(id);
				throw err;
			})
			.finally(() => {
				entry.redial = undefined;
			});
		return entry.redial;
	}

	private async redialForCall(id: string, entry: SessionEntry): Promise<RemoteSession> {
		try {
			return await this.redial(id, entry);
		} catch (err) {
			if (err instanceof SessionNotFoundError) throw err;
			const message = err instanceof Error ? err.message : String(err);
			const url = entry.config.wsUrl;
			throw new LiveViewEndedError(url ? redactMessage(message, url) : message);
		}
	}

	private watch(id: string, entry: SessionEntry, client: RemoteSession): void {
		client.onClose(() => {
			if (this.sessions.get(id) === entry && entry.client === client) this.markClosed(id, entry);
		});
	}

	private isLive(entry: SessionEntry): boolean {
		return entry.live && entry.client.state === 'connected';
	}

	// The entry stays, so the next tool call dials the same link again. The default does not move.
	private markClosed(id: string, entry: SessionEntry): void {
		if (!entry.live) return;
		entry.live = false;
		this.touch(id, entry);
	}

	// Live entry: idle timer (HTTP only). Closed entry: stale timer that drops it.
	private touch(id: string, entry: SessionEntry): void {
		clearTimeout(entry.timer);
		entry.timer = undefined;
		const live = entry.live;
		const delay = live ? this.idleTimeoutMs : this.staleTimeoutMs;
		if (delay === null) return;
		entry.timer = setTimeout(() => {
			if (this.sessions.get(id) !== entry || entry.inFlight > 0) return;
			if (!live) {
				this.drop(id);
				return;
			}
			const client = entry.client;
			this.markClosed(id, entry);
			client.disconnect();
		}, delay);
		entry.timer.unref?.();
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

	/**
	 * Removes the entry before closing its client, so the close event finds nothing to mark.
	 * Only an explicit `disconnect` moves the stdio default to another session.
	 */
	private drop(id: string, pickNewDefault = false): void {
		const entry = this.sessions.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.sessions.delete(id);
		if (this.defaultSessionId === id) {
			const keys = [...this.sessions.keys()];
			this.defaultSessionId = pickNewDefault && keys.length > 0 ? keys[keys.length - 1] : null;
		}
		entry.client.disconnect();
	}
}
