const DEFAULT_API_BASE_URL = 'https://app.threat.zone/public-api';

export function getApiBaseUrl(): string {
	return (process.env.THREATZONE_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

export function logEffectiveConfig(): void {
	const base = getApiBaseUrl();
	const isDefault = !process.env.THREATZONE_API_BASE_URL;
	if (isDefault) {
		console.error(
			`[api] base: ${base} (default — THREATZONE_API_BASE_URL not set; on-prem deployments must override this)`,
		);
	} else {
		console.error(`[api] base: ${base}`);
	}
}

export function getApiToken(override?: string): string | undefined {
	return override ?? process.env.THREATZONE_API_TOKEN;
}

export function isSubmitAllowed(): boolean {
	// MUST use strict equality — only the literal string 'true' enables submit tools.
	return process.env.THREATZONE_ALLOW_SUBMIT === 'true';
}
