import * as net from 'node:net';
import { ConnectionError, TimeoutError } from '../errors.js';

export interface ProbeResult {
	serverVersion: string;
	securityTypes: number[];
}

/**
 * Opens a disposable TCP connection to a VNC server, reads the version
 * string and security type list, then closes the socket.
 *
 * This is used to decide which backend (rfb2 vs VeNCrypt) to use
 * before opening the real connection.
 */
export function probeServer(host: string, port: number, timeoutMs = 5000): Promise<ProbeResult> {
	return new Promise<ProbeResult>((resolve, reject) => {
		const socket = new net.Socket();
		let settled = false;

		const finish = (err?: Error, result?: ProbeResult) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (err) reject(err);
			else resolve(result!);
		};

		const timeout = setTimeout(() => {
			finish(new TimeoutError('VNC probe', timeoutMs));
		}, timeoutMs);

		socket.on('error', (err) => {
			clearTimeout(timeout);
			finish(new ConnectionError(`Probe failed: ${err.message}`));
		});

		socket.connect(port, host, () => {
			const chunks: Buffer[] = [];
			let bytesRead = 0;

			socket.on('data', (data: Buffer) => {
				chunks.push(data);
				bytesRead += data.length;

				// We need at least 12 bytes for the version string
				if (bytesRead < 12) return;

				const buf = Buffer.concat(chunks);
				const serverVersion = buf.subarray(0, 12).toString('ascii').trim();

				// Send our version response
				socket.write('RFB 003.008\n');

				// Now read security types — replace listener
				const secChunks: Buffer[] = [];
				let secBytes = 0;
				const leftover = buf.subarray(12);
				if (leftover.length > 0) {
					secChunks.push(leftover);
					secBytes += leftover.length;
				}

				// Remove the current data listener and attach a new one for security types
				socket.removeAllListeners('data');
				socket.on('data', (secData: Buffer) => {
					secChunks.push(secData);
					secBytes += secData.length;
					tryParseSecurityTypes();
				});

				// Also try parsing if we already have leftover data
				if (secBytes > 0) tryParseSecurityTypes();

				function tryParseSecurityTypes() {
					const secBuf = Buffer.concat(secChunks);

					if (secBuf.length < 1) return;

					const numTypes = secBuf[0];

					if (numTypes === 0) {
						// Server is sending an error — need 4 bytes for error length
						if (secBuf.length < 5) return;
						const errLen = secBuf.readUInt32BE(1);
						if (secBuf.length < 5 + errLen) return;
						const errMsg = secBuf.subarray(5, 5 + errLen).toString('utf-8');
						clearTimeout(timeout);
						finish(new ConnectionError(`VNC server rejected connection: ${errMsg}`));
						return;
					}

					if (secBuf.length < 1 + numTypes) return;

					const securityTypes: number[] = [];
					for (let i = 0; i < numTypes; i++) {
						securityTypes.push(secBuf[1 + i]);
					}

					clearTimeout(timeout);
					finish(undefined, { serverVersion, securityTypes });
				}
			});
		});
	});
}
