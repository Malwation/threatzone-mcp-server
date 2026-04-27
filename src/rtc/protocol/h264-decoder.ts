import { spawn } from 'node:child_process';
import { H264RtpPayload } from 'werift';
import { MissingParameterSetsError, RtcConnectionError } from '../errors.js';

/**
 * Stateful H.264 RTP depacketizer. Reassembles fragmented NAL units (FU-A) and
 * unwraps Single NAL / STAP-A packets into Annex-B-prefixed NAL units suitable
 * for piping into ffmpeg. State (the in-flight FU-A fragment) is held across
 * calls.
 */
export class H264Depacketizer {
	private fragment: Buffer | undefined;

	/**
	 * Feed one RTP payload. Returns Annex-B-framed NAL unit bytes if a complete
	 * NAL became available, or null if this packet only added to a fragment.
	 * Multiple NAL units may be concatenated in the returned buffer (STAP-A).
	 */
	push(rtpPayload: Buffer): Buffer | null {
		const result = H264RtpPayload.deSerialize(rtpPayload, this.fragment);
		if (result.payload) {
			this.fragment = undefined;
			return result.payload;
		}
		if (result.fragment) {
			this.fragment = result.fragment;
		}
		return null;
	}
}

/** Returns the NAL unit type byte from an Annex-B-prefixed NAL buffer. */
export function nalType(nalu: Buffer): number {
	// Annex B prefix is 4 bytes (0,0,0,1). The next byte is the NAL header;
	// low 5 bits are the type. STAP-A wraps multiple NALs but uses the same
	// header layout for the wrapper.
	if (nalu.length < 5) return 0;
	return nalu[4] & 0x1f;
}

/**
 * Split an Annex-B-framed buffer into individual prefixed NAL units. Used to
 * unwrap STAP-A aggregates (and ordinary single-NAL packets, where the result
 * is just `[input]`).
 */
export function splitAnnexB(buf: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let i = 0;
	while (i < buf.length - 3) {
		if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
			// Find the next start code (or end-of-buffer).
			let j = i + 4;
			while (j < buf.length - 3) {
				if (buf[j] === 0 && buf[j + 1] === 0 && buf[j + 2] === 0 && buf[j + 3] === 1) {
					break;
				}
				j++;
			}
			out.push(buf.subarray(i, j === buf.length - 3 ? buf.length : j));
			i = j;
		} else {
			i++;
		}
	}
	return out;
}

interface DecodeOptions {
	format: 'png' | 'jpeg';
	quality?: number;
}

/**
 * Spawn ffmpeg, write the buffered H.264 Annex-B stream to its stdin, and read
 * the first decoded frame back as PNG/JPEG bytes from stdout. The caller is
 * responsible for ensuring `h264Stream` starts at (or contains) a keyframe;
 * otherwise ffmpeg will emit no frames before EOF.
 */
export function decodeH264ToImage(
	h264Stream: Buffer,
	opts: DecodeOptions,
	timeoutMs = 5000,
): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		// `-vf reverse -frames:v 1` reverses temporal order and outputs the
		// first frame after reversal — i.e. the LAST decoded frame. Without
		// this, ffmpeg defaults to writing the first frame (the IDR) which
		// would mean every screenshot returned the same anchor frame regardless
		// of what's happened on the device since.
		const args = [
			'-loglevel',
			'error',
			'-f',
			'h264',
			'-i',
			'pipe:0',
			'-vf',
			'reverse',
			'-frames:v',
			'1',
			'-update',
			'1',
			'-f',
			'image2',
			...(opts.format === 'jpeg'
				? ['-vcodec', 'mjpeg', '-q:v', String(qualityToFFQscale(opts.quality ?? 80))]
				: ['-vcodec', 'png']),
			'pipe:1',
		];

		const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			ff.kill('SIGKILL');
			reject(new RtcConnectionError(`ffmpeg decode timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		ff.stdout.on('data', (c: Buffer) => chunks.push(c));
		ff.stderr.on('data', (c: Buffer) => errChunks.push(c));

		ff.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new RtcConnectionError(`ffmpeg spawn failed: ${err.message}`));
		});

		ff.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0 || chunks.length === 0) {
				const stderr = Buffer.concat(errChunks).toString('utf8').trim();
				// "non-existing PPS N referenced" / "no frame!" both mean the GOP was
				// captured before the matching SPS/PPS arrived. RtcClient catches this
				// and retries once after sending a PLI.
				if (/non-existing PPS|no frame!/i.test(stderr)) {
					reject(
						new MissingParameterSetsError(`H.264 GOP missing parameter sets (ffmpeg exit ${code})`),
					);
					return;
				}
				reject(
					new RtcConnectionError(`ffmpeg exited ${code} with no image (${stderr || 'no stderr'})`),
				);
				return;
			}
			resolve(Buffer.concat(chunks));
		});

		ff.stdin.on('error', (err) => {
			// EPIPE is normal when ffmpeg has enough data and closes stdin early.
			if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new RtcConnectionError(`ffmpeg stdin error: ${err.message}`));
		});

		ff.stdin.end(h264Stream);
	});
}

/** ffmpeg's -q:v scale: 1 (best) – 31 (worst). Map 1-100 quality → 31-1. */
function qualityToFFQscale(q: number): number {
	const clamped = Math.max(1, Math.min(100, q));
	const scaled = Math.round(31 - ((clamped - 1) * 30) / 99);
	return Math.max(1, Math.min(31, scaled));
}

/**
 * Probe an H.264 Annex-B stream with ffprobe and return {width, height}. Used
 * once at connect time to populate screenSize from the first keyframe.
 */
export function probeH264Dimensions(
	h264Stream: Buffer,
	timeoutMs = 5000,
): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const args = [
			'-loglevel',
			'error',
			'-f',
			'h264',
			'-i',
			'pipe:0',
			'-show_entries',
			'stream=width,height',
			'-of',
			'csv=p=0',
		];
		const fp = spawn('ffprobe', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			fp.kill('SIGKILL');
			reject(new RtcConnectionError(`ffprobe timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		fp.stdout.on('data', (c: Buffer) => out.push(c));
		fp.stderr.on('data', (c: Buffer) => err.push(c));

		fp.on('error', (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new RtcConnectionError(`ffprobe spawn failed: ${e.message}`));
		});

		fp.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new RtcConnectionError(
						`ffprobe exited ${code}: ${Buffer.concat(err).toString('utf8').trim() || 'no stderr'}`,
					),
				);
				return;
			}
			const text = Buffer.concat(out).toString('utf8').trim();
			const [w, h] = text.split(',').map((s) => Number(s.trim()));
			if (!w || !h) {
				reject(new RtcConnectionError(`ffprobe returned malformed dims: '${text}'`));
				return;
			}
			resolve({ width: w, height: h });
		});

		fp.stdin.on('error', (e) => {
			if ((e as NodeJS.ErrnoException).code === 'EPIPE') return;
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new RtcConnectionError(`ffprobe stdin error: ${e.message}`));
		});

		fp.stdin.end(h264Stream);
	});
}
