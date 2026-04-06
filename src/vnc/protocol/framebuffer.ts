import sharp from 'sharp';
import type { ImageFormat, Region } from './protocol-types.js';

export class Framebuffer {
	private buffer: Buffer;
	width: number;
	height: number;
	private bytesPerPixel: number;
	private redShift: number;
	private greenShift: number;
	private blueShift: number;

	constructor(
		width: number,
		height: number,
		bpp: number,
		redShift: number,
		greenShift: number,
		blueShift: number,
	) {
		this.width = width;
		this.height = height;
		this.bytesPerPixel = bpp >> 3;
		this.redShift = redShift;
		this.greenShift = greenShift;
		this.blueShift = blueShift;
		// Store internally as RGBA for sharp compatibility
		this.buffer = Buffer.alloc(width * height * 4);
	}

	resize(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.buffer = Buffer.alloc(width * height * 4);
	}

	updateRect(x: number, y: number, w: number, h: number, data: Buffer): void {
		const srcBpp = this.bytesPerPixel;
		const isRGBA = this.redShift === 0 && this.greenShift === 8 && this.blueShift === 16;
		const isBGRA = this.blueShift === 0 && this.greenShift === 8 && this.redShift === 16;

		for (let row = 0; row < h; row++) {
			const destY = y + row;
			if (destY >= this.height) break;

			for (let col = 0; col < w; col++) {
				const destX = x + col;
				if (destX >= this.width) break;

				const srcOffset = (row * w + col) * srcBpp;
				const destOffset = (destY * this.width + destX) * 4;

				if (srcBpp === 4) {
					if (isRGBA) {
						// Already RGBA
						this.buffer[destOffset] = data[srcOffset];
						this.buffer[destOffset + 1] = data[srcOffset + 1];
						this.buffer[destOffset + 2] = data[srcOffset + 2];
						this.buffer[destOffset + 3] = 255;
					} else if (isBGRA) {
						// Convert BGRA -> RGBA
						this.buffer[destOffset] = data[srcOffset + 2];
						this.buffer[destOffset + 1] = data[srcOffset + 1];
						this.buffer[destOffset + 2] = data[srcOffset];
						this.buffer[destOffset + 3] = 255;
					} else {
						// Generic shift-based extraction
						const pixel =
							data[srcOffset] |
							(data[srcOffset + 1] << 8) |
							(data[srcOffset + 2] << 16) |
							(data[srcOffset + 3] << 24);
						this.buffer[destOffset] = (pixel >> this.redShift) & 0xff;
						this.buffer[destOffset + 1] = (pixel >> this.greenShift) & 0xff;
						this.buffer[destOffset + 2] = (pixel >> this.blueShift) & 0xff;
						this.buffer[destOffset + 3] = 255;
					}
				} else if (srcBpp === 3) {
					// 24-bit
					const pixel = data[srcOffset] | (data[srcOffset + 1] << 8) | (data[srcOffset + 2] << 16);
					this.buffer[destOffset] = (pixel >> this.redShift) & 0xff;
					this.buffer[destOffset + 1] = (pixel >> this.greenShift) & 0xff;
					this.buffer[destOffset + 2] = (pixel >> this.blueShift) & 0xff;
					this.buffer[destOffset + 3] = 255;
				}
			}
		}
	}

	copyRect(srcX: number, srcY: number, destX: number, destY: number, w: number, h: number): void {
		const temp = Buffer.alloc(w * h * 4);
		for (let row = 0; row < h; row++) {
			const srcOffset = ((srcY + row) * this.width + srcX) * 4;
			const tempOffset = row * w * 4;
			this.buffer.copy(temp, tempOffset, srcOffset, srcOffset + w * 4);
		}
		for (let row = 0; row < h; row++) {
			const destOffset = ((destY + row) * this.width + destX) * 4;
			const tempOffset = row * w * 4;
			temp.copy(this.buffer, destOffset, tempOffset, tempOffset + w * 4);
		}
	}

	async toImage(format: ImageFormat, region?: Region, quality?: number): Promise<Buffer> {
		let image = sharp(this.buffer, {
			raw: { width: this.width, height: this.height, channels: 4 },
		});

		if (region) {
			image = image.extract({
				left: region.x,
				top: region.y,
				width: region.width,
				height: region.height,
			});
		}

		if (format === 'jpeg') {
			return image.jpeg({ quality: quality ?? 75 }).toBuffer();
		}
		return image.png().toBuffer();
	}
}
