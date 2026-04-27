import { createHash } from 'node:crypto';
import type { ImageFormat, Region, ScreenSize } from '../../shared/remote-session.js';
import { RtcConnectionError } from '../errors.js';
import {
	decodeH264ToImage,
	H264Depacketizer,
	nalType,
	probeH264Dimensions,
	splitAnnexB,
} from './h264-decoder.js';

/** Cap the rolling buffer so a long session doesn't grow unbounded. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/**
 * Cap how many distinct SPS/PPS variants we remember. The Android encoder
 * normally only emits one of each per session, but if it restarts with new
 * IDs we want to keep enough history that an old IDR still decodes. 8 is far
 * more than any real stream produces — it's just a leak guard.
 */
const MAX_PARAM_SETS_EACH = 8;

const NAL_TYPE_IDR = 5;
const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

/**
 * Collects depacketized H.264 NAL units from a werift video track and exposes
 * frame-level operations. Holds the most recent GOP (last keyframe onward),
 * prefixed by ALL distinct SPS+PPS variants we've ever observed. ffmpeg picks
 * the matching parameter set for the IDR via `pps_id`, so prepending all of
 * them is safe and cheap (each set is 10–30 bytes).
 */
export class VideoSink {
	private depacketizer = new H264Depacketizer();
	private spsSet = new Map<string, Buffer>();
	private ppsSet = new Map<string, Buffer>();
	private gop: Buffer[] = [];
	private gopBytes = 0;
	private screenSizeCache: ScreenSize | null = null;
	private packetCounter = 0;
	private idrCounter = 0;
	private listeners = new Set<() => void>();
	private idrListeners = new Set<() => void>();
	private closed = false;

	/** Push one RTP payload (the bytes after the RTP header). */
	pushRtpPayload(payload: Buffer): void {
		if (this.closed) return;
		const nal = this.depacketizer.push(payload);
		if (!nal) return;

		// Inspect every NAL inside (STAP-A may aggregate SPS+PPS+IDR).
		const inner = splitAnnexB(nal);
		let sawIdr = false;
		for (const u of inner) {
			const t = nalType(u);
			if (t === NAL_TYPE_SPS) this.rememberParamSet(this.spsSet, u);
			else if (t === NAL_TYPE_PPS) this.rememberParamSet(this.ppsSet, u);
			else if (t === NAL_TYPE_IDR) sawIdr = true;
		}

		if (sawIdr) {
			// New GOP — anchor on every known SPS, every known PPS, then the IDR
			// itself. ffmpeg ignores parameter sets it doesn't reference; missing
			// ones cause "non-existing PPS N referenced" decode failures.
			this.gop = [];
			this.gopBytes = 0;
			for (const sps of this.spsSet.values()) this.appendNal(sps);
			for (const pps of this.ppsSet.values()) this.appendNal(pps);
			this.appendNal(nal);
			this.idrCounter++;
			for (const l of this.idrListeners) l();
		} else if (this.gop.length > 0) {
			this.appendNal(nal);
			while (this.gopBytes > MAX_BUFFER_BYTES && this.gop.length > 1) {
				const dropped = this.gop.shift();
				this.gopBytes -= dropped?.length ?? 0;
			}
		}
		this.packetCounter++;
		for (const l of this.listeners) l();
	}

	private rememberParamSet(set: Map<string, Buffer>, nal: Buffer): void {
		const key = createHash('sha1').update(nal).digest('hex');
		if (set.has(key)) return;
		set.set(key, nal);
		// FIFO eviction — Map preserves insertion order.
		while (set.size > MAX_PARAM_SETS_EACH) {
			const oldest = set.keys().next().value;
			if (oldest === undefined) break;
			set.delete(oldest);
		}
	}

	private appendNal(nal: Buffer): void {
		this.gop.push(nal);
		this.gopBytes += nal.length;
	}

	stop(): void {
		this.closed = true;
		this.gop = [];
		this.gopBytes = 0;
		this.spsSet.clear();
		this.ppsSet.clear();
		this.listeners.clear();
		this.idrListeners.clear();
	}

	hasFrame(): boolean {
		return this.gop.length > 0;
	}

	getScreenSize(): ScreenSize | null {
		return this.screenSizeCache;
	}

	/** Wait for the first keyframe-anchored GOP, then probe dimensions. */
	async waitForFirstFrame(timeoutMs: number): Promise<void> {
		await this.waitForGop(timeoutMs);
		const stream = this.snapshotGop();
		if (!stream) throw new RtcConnectionError('No GOP available after wait');
		this.screenSizeCache = await probeH264Dimensions(stream);
	}

	/**
	 * Resolve the next time an IDR (keyframe) arrives. Used by the screenshot
	 * retry path after `requestKeyframe()` sends a PLI to the gateway.
	 */
	waitForNextKeyframe(timeoutMs: number): Promise<boolean> {
		const startCounter = this.idrCounter;
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.idrListeners.delete(onIdr);
				resolve(false);
			}, timeoutMs);
			const onIdr = () => {
				if (this.idrCounter === startCounter) return;
				clearTimeout(timer);
				this.idrListeners.delete(onIdr);
				resolve(true);
			};
			this.idrListeners.add(onIdr);
		});
	}

	waitForFrameChange(timeoutMs: number): Promise<boolean> {
		const startCounter = this.packetCounter;
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.listeners.delete(onPacket);
				resolve(false);
			}, timeoutMs);
			const onPacket = () => {
				if (this.packetCounter === startCounter) return;
				clearTimeout(timer);
				this.listeners.delete(onPacket);
				resolve(true);
			};
			this.listeners.add(onPacket);
		});
	}

	async frameToImage(format: ImageFormat, region?: Region, quality?: number): Promise<Buffer> {
		const stream = this.snapshotGop();
		if (!stream) throw new RtcConnectionError('No keyframe received yet');

		const png = await decodeH264ToImage(stream, { format, quality });

		// Region cropping happens via sharp because ffmpeg doesn't crop trivially
		// without re-encoding. Lazy-import sharp so this file doesn't pay the cost
		// when no region is requested.
		if (region) {
			const sharp = (await import('sharp')).default;
			let pipeline = sharp(png).extract({
				left: region.x,
				top: region.y,
				width: region.width,
				height: region.height,
			});
			if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: quality ?? 80 });
			else pipeline = pipeline.png();
			return pipeline.toBuffer();
		}
		return png;
	}

	private snapshotGop(): Buffer | null {
		if (this.gop.length === 0) return null;
		return Buffer.concat(this.gop);
	}

	private waitForGop(timeoutMs: number): Promise<void> {
		if (this.gop.length > 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(onPacket);
				reject(new RtcConnectionError(`No keyframe received within ${timeoutMs}ms`));
			}, timeoutMs);
			const onPacket = () => {
				if (this.gop.length === 0) return;
				clearTimeout(timer);
				this.listeners.delete(onPacket);
				resolve();
			};
			this.listeners.add(onPacket);
		});
	}
}
