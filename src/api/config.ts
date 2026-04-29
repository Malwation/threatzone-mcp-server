export function getApiBaseUrl(): string {
	return (process.env.THREATZONE_API_BASE_URL ?? 'https://app.threat.zone/public-api').replace(
		/\/$/,
		'',
	);
}

export function getApiToken(override?: string): string | undefined {
	return override ?? process.env.THREATZONE_API_TOKEN;
}

export function isSubmitAllowed(): boolean {
	// MUST use strict equality — only the literal string 'true' enables submit tools.
	return process.env.THREATZONE_ALLOW_SUBMIT === 'true';
}
