/**
 * Validate an IANA time zone BY CONSTRUCTION, never by list membership.
 *
 * Do NOT "improve" this to check Intl.supportedValuesOf('timeZone'). Measured on
 * the pinned Node 24.21.0, that list holds 418 entries and does NOT contain
 * `UTC`, `Etc/UTC`, `Asia/Kolkata`, `Europe/Kyiv` or
 * `America/Argentina/Buenos_Aires`, while Intl.DateTimeFormat accepts every one
 * of them. Firefox's Intl.DateTimeFormat().resolvedOptions().timeZone — the
 * obvious way to pre-fill the registration form — reports `Asia/Kolkata` and
 * `Europe/Kyiv`, so a list check would tell an owner in Kyiv or Kolkata that
 * their own time zone is invalid, and would reject a test fixture using `UTC`.
 *
 * Worse, a list check could start rejecting a STORED value after a Node or ICU
 * update changed which alias is canonical — at a moment when the owner was only
 * renaming the restaurant.
 */
export function isValidTimeZone(tz: string): boolean {
	if (typeof tz !== 'string' || tz.trim() === '') return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * The canonical spelling of a zone, which is what gets stored.
 *
 * `Asia/Calcutta` and `Asia/Kolkata` both resolve; storing the canonical form
 * keeps one spelling in the database.
 */
export function canonicalTimeZone(tz: string): string {
	return new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
}

/**
 * Suggestions for a picker — a LIST OF SUGGESTIONS, never the validator.
 * `isValidTimeZone` is the validator, for every reason above.
 */
export function timeZoneSuggestions(): string[] {
	try {
		return Intl.supportedValuesOf('timeZone');
	} catch {
		return [];
	}
}
