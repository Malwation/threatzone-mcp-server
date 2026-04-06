import Redis from 'ioredis';
import { TokenResolutionError } from '../errors.js';

interface VncTarget {
	host: string;
	port: number;
}

export class TokenResolver {
	private redis: Redis;

	constructor(connectionString: string) {
		this.redis = new Redis(connectionString);
	}

	async resolve(token: string): Promise<VncTarget> {
		const key = `vnc-${token}`;
		const value = await this.redis.get(key);

		if (!value) {
			throw new TokenResolutionError(token, `key '${key}' not found in Redis`);
		}

		try {
			const parsed = JSON.parse(value) as Record<string, unknown>;

			const host = (parsed.host as string) ?? (parsed.hostname as string);
			if (!host) {
				throw new Error('missing host/hostname field');
			}

			// Handle "host:port" format in the host field
			if (typeof host === 'string' && host.includes(':') && !parsed.port) {
				const [h, p] = host.split(':');
				return { host: h, port: Number(p) };
			}

			const port = parsed.port ? Number(parsed.port) : Number(process.env.VNC_DEFAULT_PORT) || 5901;
			return { host, port };
		} catch (err) {
			throw new TokenResolutionError(
				token,
				`failed to parse Redis value: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async disconnect(): Promise<void> {
		await this.redis.quit();
	}
}
