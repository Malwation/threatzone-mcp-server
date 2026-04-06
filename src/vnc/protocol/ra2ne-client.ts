import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { AuthenticationError, ConnectionError, TimeoutError } from '../errors.js';
import type { RfbBackend, RfbRect } from './rfb-backend.js';
import { type WebSocketTransport, wsConnect } from './ws-transport.js';

/* ------------------------------------------------------------------ */
/*  RFB protocol constants                                             */
/* ------------------------------------------------------------------ */

const CLIENT_MSG = {
	setPixelFormat: 0,
	setEncodings: 2,
	fbUpdate: 3,
	keyEvent: 4,
	pointerEvent: 5,
	clientCutText: 6,
} as const;

const SERVER_MSG = {
	fbUpdate: 0,
	setColorMap: 1,
	bell: 2,
	cutText: 3,
} as const;

const ENCODINGS = {
	raw: 0,
	copyRect: 1,
	pseudoDesktopSize: -223,
	extendedClipboard: -260,
} as const;

const RA2_SUBTYPE_USERPASS = 1;

/* ------------------------------------------------------------------ */
/*  AES-EAX helpers                                                    */
/*  EAX = CTR encryption + OMAC for authentication                     */
/* ------------------------------------------------------------------ */

/**
 * AES-EAX encrypt: returns ciphertext + 16-byte MAC.
 * Associated data (AD) is the 2-byte big-endian length prefix.
 */
function eaxEncrypt(
	key: Buffer,
	nonce: Buffer,
	plaintext: Buffer,
	ad: Buffer,
): { ciphertext: Buffer; mac: Buffer } {
	// EAX mode: encrypt then MAC
	// N = OMAC(0 || nonce), H = OMAC(1 || ad), C = CTR(key, N, plaintext), T = OMAC(2 || ciphertext), tag = N ^ H ^ T
	const omacN = omac(key, 0, nonce);
	const omacH = omac(key, 1, ad);

	// CTR encrypt with IV = omacN
	const cipher = crypto.createCipheriv(
		key.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr',
		key,
		omacN,
	);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

	const omacC = omac(key, 2, ciphertext);

	// tag = omacN XOR omacH XOR omacC
	const mac = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) {
		mac[i] = omacN[i] ^ omacH[i] ^ omacC[i];
	}

	return { ciphertext, mac };
}

/**
 * AES-EAX decrypt: verifies MAC and returns plaintext.
 */
function eaxDecrypt(
	key: Buffer,
	nonce: Buffer,
	ciphertext: Buffer,
	ad: Buffer,
	mac: Buffer,
): Buffer {
	const omacN = omac(key, 0, nonce);
	const omacH = omac(key, 1, ad);
	const omacC = omac(key, 2, ciphertext);

	// Verify tag
	const expectedMac = Buffer.alloc(16);
	for (let i = 0; i < 16; i++) {
		expectedMac[i] = omacN[i] ^ omacH[i] ^ omacC[i];
	}

	if (!crypto.timingSafeEqual(mac, expectedMac)) {
		throw new AuthenticationError('EAX MAC verification failed');
	}

	// CTR decrypt
	const decipher = crypto.createDecipheriv(
		key.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr',
		key,
		omacN,
	);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * OMAC (One-key MAC / CMAC) computation.
 * tweak: 0 for nonce, 1 for AAD, 2 for ciphertext.
 */
function omac(key: Buffer, tweak: number, data: Buffer): Buffer {
	const blockSize = 16;
	const algo = key.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc';

	// Generate subkeys L, B, P
	const zeroBlock = Buffer.alloc(blockSize);
	const ecb = crypto.createCipheriv(key.length === 16 ? 'aes-128-ecb' : 'aes-256-ecb', key, null);
	ecb.setAutoPadding(false);
	const L = ecb.update(zeroBlock);
	ecb.final();

	const B = dbl(L);
	const P = dbl(B);

	// Prepend tweak byte: [tweak, 0, 0, ..., 0] is the first block for EAX
	const tweakBlock = Buffer.alloc(blockSize);
	tweakBlock[blockSize - 1] = tweak;

	// Full input = tweakBlock || data
	const input = Buffer.concat([tweakBlock, data]);

	// Process with CMAC logic
	const numBlocks = Math.ceil(input.length / blockSize);
	const lastBlockSize = input.length % blockSize || blockSize;
	const isComplete = input.length > 0 && lastBlockSize === blockSize;

	// XOR the subkey into the last block
	const padded = Buffer.alloc(numBlocks * blockSize);
	input.copy(padded);

	if (!isComplete && input.length > blockSize) {
		// Pad last block: append 0x80 then zeros
		padded[input.length] = 0x80;
	}

	const lastBlockStart = (numBlocks - 1) * blockSize;
	const subkey = isComplete ? B : P;
	for (let i = 0; i < blockSize; i++) {
		padded[lastBlockStart + i] ^= subkey[i];
	}

	// CBC-MAC: encrypt all blocks, take last block as MAC
	const iv = Buffer.alloc(blockSize);
	const cbcCipher = crypto.createCipheriv(algo, key, iv);
	cbcCipher.setAutoPadding(false);
	const encrypted = cbcCipher.update(padded);
	cbcCipher.final();

	// Last 16 bytes of the CBC output is the MAC
	return encrypted.subarray(encrypted.length - blockSize);
}

/** Double in GF(2^128) — used for CMAC subkey derivation */
function dbl(buf: Buffer): Buffer {
	const result = Buffer.alloc(16);
	let carry = 0;
	for (let i = 15; i >= 0; i--) {
		const val = (buf[i] << 1) | carry;
		result[i] = val & 0xff;
		carry = (buf[i] >> 7) & 1;
	}
	if ((buf[0] >> 7) & 1) {
		result[15] ^= 0x87; // Rb for 128-bit
	}
	return result;
}

/** Increment a 16-byte little-endian counter */
function incrementCounter(counter: Buffer): void {
	for (let i = 0; i < 16; i++) {
		counter[i]++;
		if (counter[i] !== 0) break;
	}
}

/* ------------------------------------------------------------------ */
/*  Buffered socket reader                                             */
/* ------------------------------------------------------------------ */

class BufferedReader {
	private chunks: Buffer[] = [];
	private buffered = 0;
	private waiting: { needed: number; resolve: (buf: Buffer) => void } | null = null;
	private errorHandler: ((err: Error) => void) | null = null;

	constructor(private stream: EventEmitter) {
		stream.on('data', (data: Buffer) => {
			this.chunks.push(data);
			this.buffered += data.length;
			this.tryDeliver();
		});
		stream.on('error', (err) => this.errorHandler?.(err));
	}

	onError(handler: (err: Error) => void): void {
		this.errorHandler = handler;
	}

	read(n: number): Promise<Buffer> {
		return new Promise<Buffer>((resolve) => {
			this.waiting = { needed: n, resolve };
			this.tryDeliver();
		});
	}

	async readUInt8(): Promise<number> {
		return (await this.read(1))[0];
	}

	async readUInt16BE(): Promise<number> {
		return (await this.read(2)).readUInt16BE(0);
	}

	async readUInt32BE(): Promise<number> {
		return (await this.read(4)).readUInt32BE(0);
	}

	async readInt32BE(): Promise<number> {
		return (await this.read(4)).readInt32BE(0);
	}

	private tryDeliver(): void {
		if (!this.waiting || this.buffered < this.waiting.needed) return;
		const { needed, resolve } = this.waiting;
		this.waiting = null;
		const merged = Buffer.concat(this.chunks);
		this.chunks = merged.length > needed ? [merged.subarray(needed)] : [];
		this.buffered = merged.length - needed;
		resolve(merged.subarray(0, needed));
	}
}

/* ------------------------------------------------------------------ */
/*  RA2ne client implementing RfbBackend                               */
/* ------------------------------------------------------------------ */

/** Supported RSA-AES security types, preferred order.
 * Type 6 = RA2ne (handshake encrypted, post-auth unencrypted)
 * Type 133 = RA2ne_256 (same but SHA-256)
 * Types 13/130 = RSA-AES (fully encrypted session — not yet supported)
 * Types 5/129 = RA2/RA2_256 (fully encrypted session — not yet supported)
 */
const SUPPORTED_RA2_TYPES = [6, 5, 13, 133, 129, 130];

/* ------------------------------------------------------------------ */
/*  Protocol reader interface + EAX-encrypted reader                    */
/* ------------------------------------------------------------------ */

interface ProtocolReader {
	read(n: number): Promise<Buffer>;
	readUInt8(): Promise<number>;
	readUInt16BE(): Promise<number>;
	readUInt32BE(): Promise<number>;
	readInt32BE(): Promise<number>;
}

class EaxReader implements ProtocolReader {
	private decryptedChunks: Buffer[] = [];
	private decryptedBuffered = 0;
	private waiting: { needed: number; resolve: (buf: Buffer) => void } | null = null;

	constructor(
		private rawReader: BufferedReader,
		private serverKey: Buffer,
		private serverCounter: Buffer,
	) {}

	read(n: number): Promise<Buffer> {
		return new Promise<Buffer>((resolve) => {
			this.waiting = { needed: n, resolve };
			this.tryDeliver();
			if (this.waiting) this.pumpLoop();
		});
	}

	async readUInt8(): Promise<number> {
		return (await this.read(1))[0];
	}

	async readUInt16BE(): Promise<number> {
		return (await this.read(2)).readUInt16BE(0);
	}

	async readUInt32BE(): Promise<number> {
		return (await this.read(4)).readUInt32BE(0);
	}

	async readInt32BE(): Promise<number> {
		return (await this.read(4)).readInt32BE(0);
	}

	private async pumpLoop(): Promise<void> {
		while (this.waiting && this.decryptedBuffered < this.waiting.needed) {
			await this.pumpOne();
		}
	}

	private async pumpOne(): Promise<void> {
		const msgLen = await this.rawReader.readUInt16BE();
		const ciphertext = await this.rawReader.read(msgLen);
		const mac = await this.rawReader.read(16);

		const ad = Buffer.alloc(2);
		ad.writeUInt16BE(msgLen, 0);

		const plaintext = eaxDecrypt(this.serverKey, this.serverCounter, ciphertext, ad, mac);
		incrementCounter(this.serverCounter);

		this.decryptedChunks.push(plaintext);
		this.decryptedBuffered += plaintext.length;
		this.tryDeliver();
	}

	private tryDeliver(): void {
		if (!this.waiting || this.decryptedBuffered < this.waiting.needed) return;
		const { needed, resolve } = this.waiting;
		this.waiting = null;
		const merged = Buffer.concat(this.decryptedChunks);
		this.decryptedChunks = merged.length > needed ? [merged.subarray(needed)] : [];
		this.decryptedBuffered = merged.length - needed;
		resolve(merged.subarray(0, needed));
	}
}

/* ------------------------------------------------------------------ */
/*  RA2ne / RA2 client                                                 */
/* ------------------------------------------------------------------ */

export interface Ra2neConnectOptions {
	host: string;
	port: number;
	username: string;
	password: string;
	wsUrl?: string;
	wsHeaders?: Record<string, string>;
}

export class Ra2neClient extends EventEmitter implements RfbBackend {
	width = 0;
	height = 0;
	bpp = 0;
	depth = 0;
	isBigEndian = 0;
	isTrueColor = 0;
	redMax = 0;
	greenMax = 0;
	blueMax = 0;
	redShift = 0;
	greenShift = 0;
	blueShift = 0;

	private socket: net.Socket | WebSocketTransport | null = null;
	private reader: BufferedReader | null = null;
	private activeReader: ProtocolReader | null = null;
	private readonly options: Ra2neConnectOptions;
	private serverSupportsExtClipboard = false;

	/* Encryption state — populated during handshake, used post-auth for RA2 types */
	private encryptedMode = false;
	private clientSessionKeyBuf: Buffer | null = null;
	private clientCounterBuf: Buffer | null = null;

	constructor(options: Ra2neConnectOptions) {
		super();
		this.options = options;
	}

	/* RfbBackend methods */

	requestUpdate(incremental: boolean, x: number, y: number, w: number, h: number): void {
		const buf = Buffer.alloc(10);
		buf[0] = CLIENT_MSG.fbUpdate;
		buf[1] = incremental ? 1 : 0;
		buf.writeUInt16BE(x, 2);
		buf.writeUInt16BE(y, 4);
		buf.writeUInt16BE(w, 6);
		buf.writeUInt16BE(h, 8);
		this.write(buf);
	}

	keyEvent(keysym: number, down: number): void {
		const buf = Buffer.alloc(8);
		buf[0] = CLIENT_MSG.keyEvent;
		buf[1] = down;
		buf.writeUInt32BE(keysym, 4);
		this.write(buf);
	}

	pointerEvent(x: number, y: number, buttonMask: number): void {
		const buf = Buffer.alloc(6);
		buf[0] = CLIENT_MSG.pointerEvent;
		buf[1] = buttonMask;
		buf.writeUInt16BE(x, 2);
		buf.writeUInt16BE(y, 4);
		this.write(buf);
	}

	clientCutText(text: string): void {
		if (this.serverSupportsExtClipboard) {
			const utf8Buf = Buffer.from(text, 'utf-8');
			const compressed = zlib.deflateSync(utf8Buf);
			// flags: text(1) | provide(2) = 3
			const payload = Buffer.alloc(4 + 4 + compressed.length);
			payload.writeUInt32BE(3, 0);
			payload.writeUInt32BE(utf8Buf.length, 4);
			compressed.copy(payload, 8);

			const header = Buffer.alloc(8);
			header[0] = CLIENT_MSG.clientCutText;
			header.writeUInt32BE((payload.length | 0x80000000) >>> 0, 4);
			this.write(Buffer.concat([header, payload]));
		} else {
			const textBuf = Buffer.from(text, 'latin1');
			const buf = Buffer.alloc(8 + textBuf.length);
			buf[0] = CLIENT_MSG.clientCutText;
			buf.writeUInt32BE(textBuf.length, 4);
			textBuf.copy(buf, 8);
			this.write(buf);
		}
	}

	private sendExtendedClipboardCaps(): void {
		// flags: caps(16) | text(1) = 17
		const payload = Buffer.alloc(4 + 4);
		payload.writeUInt32BE(17, 0);
		payload.writeUInt32BE(10 * 1024 * 1024, 4); // 10MB max for text

		const header = Buffer.alloc(8);
		header[0] = CLIENT_MSG.clientCutText;
		header.writeUInt32BE((payload.length | 0x80000000) >>> 0, 4);
		this.write(Buffer.concat([header, payload]));
	}

	end(): void {
		this.socket?.destroy();
		this.socket = null;
	}

	/* Connection */

	async connect(timeoutMs = 10000): Promise<void> {
		this.socket = await this.transportConnect(timeoutMs);
		this.reader = new BufferedReader(this.socket);
		this.reader.onError((err) => this.emit('error', err));
		this.socket.on('end', () => this.emit('end'));

		try {
			await Promise.race([
				this.handshake(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new TimeoutError('RA2ne handshake', timeoutMs)), timeoutMs),
				),
			]);
		} catch (err) {
			this.end();
			throw err;
		}
	}

	/* RA2ne Handshake */

	private async handshake(): Promise<void> {
		const reader = this.reader!;
		const dbg = (_msg: string) => {};

		// 1. RFB version negotiation
		dbg('reading server version...');
		const versionBuf = await reader.read(12);
		dbg(`server version: ${versionBuf.toString('ascii').trim()}`);
		this.write(Buffer.from('RFB 003.008\n', 'ascii'));

		// 2. Security type selection — pick best supported RA2 type
		dbg('reading security types...');
		const serverVersion = versionBuf.toString('ascii').trim();
		let typeList: number[];

		if (serverVersion === 'RFB 003.003') {
			// RFB 3.003: single security type as 32-bit integer
			const singleType = await reader.readUInt32BE();
			if (singleType === 0) {
				const errLen = await reader.readUInt32BE();
				const errMsg = (await reader.read(errLen)).toString('utf-8');
				throw new ConnectionError(`VNC server error: ${errMsg}`);
			}
			typeList = [singleType];
		} else {
			// RFB 3.007+: count + byte array of types
			const numTypes = await reader.readUInt8();
			if (numTypes === 0) {
				const errLen = await reader.readUInt32BE();
				const errMsg = (await reader.read(errLen)).toString('utf-8');
				throw new ConnectionError(`VNC server error: ${errMsg}`);
			}
			const secTypes = await reader.read(numTypes);
			typeList = [];
			for (let i = 0; i < numTypes; i++) typeList.push(secTypes[i]);
		}

		const secType = SUPPORTED_RA2_TYPES.find((t) => typeList.includes(t));
		if (secType === undefined) {
			throw new ConnectionError(
				`Server does not support any RSA-AES type. Available: [${typeList.join(', ')}]`,
			);
		}
		dbg(`selected security type: ${secType} from [${typeList.join(', ')}]`);
		// For 3.003, server already selected the type; for 3.007+ we need to send our choice
		if (serverVersion !== 'RFB 003.003') {
			this.write(Buffer.from([secType]));
		}

		const is256 = secType === 129 || secType === 133;
		const keyBytes = is256 ? 32 : 16;
		const hashAlgo = is256 ? 'sha256' : 'sha1';

		// 3. Read server public key
		dbg('reading server public key...');
		const serverKeyLen = await reader.readUInt32BE(); // bits
		const serverKeyBytes = serverKeyLen / 8;
		const serverN = await reader.read(serverKeyBytes);
		const serverE = await reader.read(serverKeyBytes);

		dbg(`server key: ${serverKeyLen} bits`);

		// 4. Generate client RSA keypair (matching server key size)
		const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
			modulusLength: serverKeyLen,
			publicExponent: 65537,
			publicKeyEncoding: { type: 'pkcs1', format: 'der' },
			privateKeyEncoding: { type: 'pkcs1', format: 'der' },
		});

		// Extract N and E from client's DER-encoded public key
		const clientKeyObj = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'pkcs1' });
		const clientJwk = clientKeyObj.export({ format: 'jwk' });
		const clientN = Buffer.from(clientJwk.n!, 'base64url');
		const clientE = Buffer.from(clientJwk.e!, 'base64url');

		// Pad to match server key size
		const clientNPadded = padToLength(clientN, serverKeyBytes);
		const clientEPadded = padToLength(clientE, serverKeyBytes);

		// Send client public key
		const keyLenBuf = Buffer.alloc(4);
		keyLenBuf.writeUInt32BE(serverKeyLen, 0);
		this.write(keyLenBuf);
		this.write(clientNPadded);
		this.write(clientEPadded);

		dbg('sent client public key, reading server encrypted random...');

		// 5. Read server's encrypted random
		const serverEncLen = await reader.readUInt16BE();
		const serverEncRandom = await reader.read(serverEncLen);

		// Decrypt server random with client's private key
		const clientPrivKey = crypto.createPrivateKey({
			key: privateKey,
			format: 'der',
			type: 'pkcs1',
		});
		const serverRandom = crypto.privateDecrypt(
			{ key: clientPrivKey, padding: crypto.constants.RSA_PKCS1_PADDING },
			serverEncRandom,
		);

		// 6. Generate and send client random
		const clientRandom = crypto.randomBytes(keyBytes);

		// Encrypt with server's public key
		const serverPubKey = buildRsaPublicKey(serverN, serverE);
		const clientEncRandom = crypto.publicEncrypt(
			{ key: serverPubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
			clientRandom,
		);

		const encLenBuf = Buffer.alloc(2);
		encLenBuf.writeUInt16BE(clientEncRandom.length, 0);
		this.write(encLenBuf);
		this.write(clientEncRandom);

		dbg('key exchange complete, deriving session keys...');

		// 7. Derive session keys
		// Per spec: ClientSessionKey = Hash(ServerRandom || ClientRandom)
		//           ServerSessionKey = Hash(ClientRandom || ServerRandom)
		const clientSessionKey = crypto
			.createHash(hashAlgo)
			.update(serverRandom)
			.update(clientRandom)
			.digest()
			.subarray(0, keyBytes);
		const serverSessionKey = crypto
			.createHash(hashAlgo)
			.update(clientRandom)
			.update(serverRandom)
			.digest()
			.subarray(0, keyBytes);

		dbg('reading server hash...');

		// 8. Read and verify server hash
		const serverCounter = Buffer.alloc(16);
		const clientCounter = Buffer.alloc(16);

		// Server hash message: [2-byte len][encrypted hash][16-byte MAC]
		const serverHashMsgLen = await reader.readUInt16BE();
		const serverHashCipher = await reader.read(serverHashMsgLen);
		const serverHashMac = await reader.read(16);

		const serverHashAD = Buffer.alloc(2);
		serverHashAD.writeUInt16BE(serverHashMsgLen, 0);

		const serverHashPlain = eaxDecrypt(
			serverSessionKey,
			serverCounter,
			serverHashCipher,
			serverHashAD,
			serverHashMac,
		);
		incrementCounter(serverCounter);

		// Compute expected server hash: hash(serverPubKey || clientPubKey)
		// Each key block: 4-byte length + N + E
		const serverKeyBlock = Buffer.concat([keyLenBuf, serverN, serverE]);
		const clientKeyBlock = Buffer.concat([keyLenBuf, clientNPadded, clientEPadded]);
		const expectedServerHash = crypto
			.createHash(hashAlgo)
			.update(serverKeyBlock)
			.update(clientKeyBlock)
			.digest();

		if (!crypto.timingSafeEqual(serverHashPlain, expectedServerHash)) {
			throw new AuthenticationError('Server identity verification failed');
		}

		dbg('server hash verified, sending client hash...');

		// 9. Send client hash: hash(clientPubKey || serverPubKey)
		const clientHash = crypto
			.createHash(hashAlgo)
			.update(clientKeyBlock)
			.update(serverKeyBlock)
			.digest();

		const clientHashAD = Buffer.alloc(2);
		clientHashAD.writeUInt16BE(clientHash.length, 0);
		const { ciphertext: clientHashCipher, mac: clientHashMac } = eaxEncrypt(
			clientSessionKey,
			clientCounter,
			clientHash,
			clientHashAD,
		);
		incrementCounter(clientCounter);

		this.write(Buffer.concat([clientHashAD, clientHashCipher, clientHashMac]));

		dbg('reading subtype...');

		// 10. Read subtype (encrypted)
		const subtypeMsgLen = await reader.readUInt16BE();
		const subtypeCipher = await reader.read(subtypeMsgLen);
		const subtypeMac = await reader.read(16);
		const subtypeAD = Buffer.alloc(2);
		subtypeAD.writeUInt16BE(subtypeMsgLen, 0);
		const subtypePlain = eaxDecrypt(
			serverSessionKey,
			serverCounter,
			subtypeCipher,
			subtypeAD,
			subtypeMac,
		);
		incrementCounter(serverCounter);

		const subtype = subtypePlain[0];

		dbg(`subtype: ${subtype}, sending credentials...`);

		// 11. Send credentials (encrypted)
		const { username, password } = this.options;
		const userBuf = Buffer.from(username, 'utf-8');
		const passBuf = Buffer.from(password, 'utf-8');

		let credPayload: Buffer;
		if (subtype === RA2_SUBTYPE_USERPASS) {
			credPayload = Buffer.alloc(2 + userBuf.length + passBuf.length);
			credPayload[0] = userBuf.length;
			userBuf.copy(credPayload, 1);
			credPayload[1 + userBuf.length] = passBuf.length;
			passBuf.copy(credPayload, 2 + userBuf.length);
		} else {
			// Password only
			credPayload = Buffer.alloc(2 + passBuf.length);
			credPayload[0] = 0; // no username
			credPayload[1] = passBuf.length;
			passBuf.copy(credPayload, 2);
		}

		const credAD = Buffer.alloc(2);
		credAD.writeUInt16BE(credPayload.length, 0);
		const { ciphertext: credCipher, mac: credMac } = eaxEncrypt(
			clientSessionKey,
			clientCounter,
			credPayload,
			credAD,
		);
		incrementCounter(clientCounter);

		dbg(`cred payload (${credPayload.length} bytes): ${credPayload.toString('hex')}`);
		dbg(`clientCounter for cred: ${clientCounter[0]}`);
		dbg(`clientSessionKey: ${clientSessionKey.toString('hex')}`);
		dbg(
			`cred EAX: ad=${credAD.toString('hex')} ct=${credCipher.toString('hex')} mac=${credMac.toString('hex')}`,
		);

		// Send as single buffer to avoid TCP framing issues
		this.write(Buffer.concat([credAD, credCipher, credMac]));

		dbg('reading security result...');

		// RA2ne types (6, 133): handshake encrypted, post-auth unencrypted
		// RA2 types (5, 13, 129, 130): fully encrypted
		const isNe = secType === 6 || secType === 133;

		// 12. Read security result

		if (isNe) {
			const secResult = await reader.readUInt32BE();
			dbg(`security result (unencrypted): ${secResult}`);
			if (secResult !== 0) {
				try {
					const errLen = await reader.readUInt32BE();
					const errMsg = (await reader.read(errLen)).toString('utf-8');
					throw new AuthenticationError(`Authentication failed: ${errMsg}`);
				} catch (err) {
					if (err instanceof AuthenticationError) throw err;
					throw new AuthenticationError('Authentication failed');
				}
			}
		} else {
			const resultMsgLen = await reader.readUInt16BE();
			dbg(`security result EAX len: ${resultMsgLen}`);
			const resultCipher = await reader.read(resultMsgLen);
			const resultMac = await reader.read(16);
			const resultAD = Buffer.alloc(2);
			resultAD.writeUInt16BE(resultMsgLen, 0);
			const resultPlain = eaxDecrypt(
				serverSessionKey,
				serverCounter,
				resultCipher,
				resultAD,
				resultMac,
			);
			incrementCounter(serverCounter);

			const secResult = resultPlain.readUInt32BE(0);
			dbg(`security result (encrypted): ${secResult}`);
			if (secResult !== 0) {
				throw new AuthenticationError('Authentication failed');
			}
		}

		// 13. Activate encryption for RA2 types (not RA2ne)
		if (!isNe) {
			this.encryptedMode = true;
			this.clientSessionKeyBuf = clientSessionKey;
			this.clientCounterBuf = clientCounter;
			this.activeReader = new EaxReader(this.reader!, serverSessionKey, serverCounter);
		} else {
			this.activeReader = this.reader!;
		}

		// 14. Standard RFB init
		await this.rfbInit();
	}

	private async rfbInit(): Promise<void> {
		const reader = this.activeReader!;

		// ClientInit — shared connection
		this.write(Buffer.from([1]));

		// ServerInit
		this.width = await reader.readUInt16BE();
		this.height = await reader.readUInt16BE();

		// Pixel format (16 bytes)
		const pf = await reader.read(16);
		this.bpp = pf[0];
		this.depth = pf[1];
		this.isBigEndian = pf[2];
		this.isTrueColor = pf[3];
		this.redMax = pf.readUInt16BE(4);
		this.greenMax = pf.readUInt16BE(6);
		this.blueMax = pf.readUInt16BE(8);
		this.redShift = pf[10];
		this.greenShift = pf[11];
		this.blueShift = pf[12];

		// Desktop name
		const nameLen = await reader.readUInt32BE();
		await reader.read(nameLen);

		// SetPixelFormat
		const spf = Buffer.alloc(20);
		spf[0] = CLIENT_MSG.setPixelFormat;
		pf.copy(spf, 4);
		this.write(spf);

		// SetEncodings
		const encodingList = [ENCODINGS.raw, ENCODINGS.copyRect, ENCODINGS.pseudoDesktopSize];
		const se = Buffer.alloc(4 + encodingList.length * 4);
		se[0] = CLIENT_MSG.setEncodings;
		se.writeUInt16BE(encodingList.length, 2);
		for (let i = 0; i < encodingList.length; i++) {
			se.writeInt32BE(encodingList[i], 4 + i * 4);
		}
		this.write(se);

		// Note: extended clipboard caps are sent only after server announces support

		// Request initial framebuffer update
		this.requestUpdate(false, 0, 0, this.width, this.height);

		// Start message loop
		this.messageLoop();
		this.emit('connect');
	}

	/* RFB message loop */

	private async messageLoop(): Promise<void> {
		const reader = this.activeReader!;
		try {
			while (true) {
				const msgType = await reader.readUInt8();
				switch (msgType) {
					case SERVER_MSG.fbUpdate:
						await this.readFbUpdate(reader);
						break;
					case SERVER_MSG.setColorMap:
						await this.readColorMap(reader);
						break;
					case SERVER_MSG.bell:
						this.emit('bell');
						break;
					case SERVER_MSG.cutText:
						await this.readCutText(reader);
						break;
					default:
						console.error(`RA2ne: unknown server message type ${msgType}`);
						return;
				}
			}
		} catch (err) {
			if (this.socket?.destroyed) return;
			this.emit('error', err instanceof Error ? err : new Error(String(err)));
		}
	}

	private async readFbUpdate(reader: ProtocolReader): Promise<void> {
		await reader.read(1); // padding
		const numRects = await reader.readUInt16BE();
		for (let i = 0; i < numRects; i++) {
			const x = await reader.readUInt16BE();
			const y = await reader.readUInt16BE();
			const width = await reader.readUInt16BE();
			const height = await reader.readUInt16BE();
			const encoding = await reader.readInt32BE();

			if (encoding === ENCODINGS.pseudoDesktopSize) {
				this.width = width;
				this.height = height;
				this.emit('resize', { width, height });
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: Buffer.alloc(0),
					buffer: Buffer.alloc(0),
				} satisfies RfbRect);
				continue;
			}
			if (encoding === ENCODINGS.copyRect) {
				const copyData = await reader.read(4);
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: copyData,
					buffer: copyData,
				} satisfies RfbRect);
				continue;
			}
			if (encoding === ENCODINGS.raw) {
				const bytesPerPixel = this.bpp >> 3;
				const pixelData = await reader.read(width * height * bytesPerPixel);
				this.emit('rect', {
					x,
					y,
					width,
					height,
					encoding,
					data: pixelData,
					buffer: pixelData,
				} satisfies RfbRect);
				continue;
			}
			console.error(`RA2ne: unknown encoding ${encoding}`);
			return;
		}
	}

	private async readColorMap(reader: ProtocolReader): Promise<void> {
		await reader.read(1);
		await reader.readUInt16BE();
		const numColors = await reader.readUInt16BE();
		await reader.read(numColors * 6);
	}

	private async readCutText(reader: ProtocolReader): Promise<void> {
		await reader.read(3); // padding
		const rawLen = await reader.readUInt32BE();

		if (rawLen & 0x80000000) {
			// Extended clipboard format
			const payloadLen = rawLen & 0x7fffffff;
			const payload = await reader.read(payloadLen);
			const flags = payload.readUInt32BE(0);

			if (flags & 16) {
				// Caps message — server supports extended clipboard
				this.serverSupportsExtClipboard = true;
				this.sendExtendedClipboardCaps();
				return;
			}
			if (flags & 2 && flags & 1) {
				// Provide action with text format: [flags][uncompressedSize][zlib data]
				const uncompressedSize = payload.readUInt32BE(4);
				const compressed = payload.subarray(8);
				try {
					const text = zlib.inflateSync(compressed).toString('utf-8');
					this.emit('clipboard', text);
				} catch {
					// Decompression failed — try as raw UTF-8
					this.emit('clipboard', compressed.toString('utf-8'));
				}
				return;
			}
			// Other extended formats — ignore
			return;
		}

		// Standard Latin-1 cuttext
		const text = (await reader.read(rawLen)).toString('latin1');
		this.emit('clipboard', text);
	}

	/* Helpers */

	private async transportConnect(timeoutMs: number): Promise<net.Socket | WebSocketTransport> {
		if (this.options.wsUrl) {
			return wsConnect(this.options.wsUrl, timeoutMs, this.options.wsHeaders);
		}
		return new Promise<net.Socket>((resolve, reject) => {
			const socket = new net.Socket();
			const timeout = setTimeout(() => {
				socket.destroy();
				reject(new TimeoutError('VNC TCP connect', timeoutMs));
			}, timeoutMs);

			socket.on('error', (err) => {
				clearTimeout(timeout);
				reject(new ConnectionError(`TCP connection failed: ${err.message}`));
			});

			socket.connect(this.options.port, this.options.host, () => {
				clearTimeout(timeout);
				resolve(socket);
			});
		});
	}

	private write(data: Buffer): void {
		if (this.socket && !this.socket.destroyed) {
			if (this.encryptedMode && this.clientSessionKeyBuf && this.clientCounterBuf) {
				const ad = Buffer.alloc(2);
				ad.writeUInt16BE(data.length, 0);
				const { ciphertext, mac } = eaxEncrypt(
					this.clientSessionKeyBuf,
					this.clientCounterBuf,
					data,
					ad,
				);
				incrementCounter(this.clientCounterBuf);
				this.socket.write(Buffer.concat([ad, ciphertext, mac]));
			} else {
				this.socket.write(data);
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/*  RSA key construction helper                                        */
/* ------------------------------------------------------------------ */

/** Build an RSA public key object from raw N and E big-endian buffers */
function buildRsaPublicKey(n: Buffer, e: Buffer): crypto.KeyObject {
	// Use JWK format to construct the key
	const jwk = {
		kty: 'RSA' as const,
		n: n.toString('base64url'),
		e: e.toString('base64url'),
	};
	return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/** Pad (or trim) a buffer to the specified length with leading zeros */
function padToLength(buf: Buffer, len: number): Buffer {
	if (buf.length === len) return buf;
	if (buf.length > len) return buf.subarray(buf.length - len);
	const padded = Buffer.alloc(len);
	buf.copy(padded, len - buf.length);
	return padded;
}
