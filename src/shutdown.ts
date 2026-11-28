/** Exit codes a shell gives a process that a signal stops: 128 + signal number. */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/** On SIGINT or SIGTERM: close every VNC session, then exit with 130 or 143. */
export function installShutdownHandlers(sessions: { disconnectAll(): void }): void {
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			console.error(`[mcp] ${signal}: closing VNC sessions`);
			sessions.disconnectAll();
			process.exit(SIGNAL_EXIT_CODES[signal]);
		});
	}
}
