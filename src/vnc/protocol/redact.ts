/** Removes the query and fragment so a live-view token never reaches tool output. */
export function redactUrl(raw: string): string {
	try {
		const parsed = new URL(raw);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return '<invalid URL>';
	}
}

/** Replaces the full URL and its `token` query value in an error message. */
export function redactMessage(message: string, url: string): string {
	let safe = message.split(url).join(redactUrl(url));
	try {
		const token = new URL(url).searchParams.get('token');
		if (token) safe = safe.split(token).join('<redacted>');
	} catch {
		// Not a URL: the split above already removed it.
	}
	return safe;
}
