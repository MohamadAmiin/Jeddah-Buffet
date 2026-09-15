import { isIP } from 'node:net';

const UNKNOWN = 'unknown';

/**
 * The key a public sign-up is throttled and counted under — the daily cap is
 * "3 new companies per address per 24 hours" (decided 2026-09-15).
 *
 *   - IPv4: the address itself.
 *   - IPv4-mapped IPv6 (`::ffff:203.0.113.9`): the IPv4 inside it, so one visitor
 *     is one key whichever way the socket reports them.
 *   - IPv6: its /64. A subscriber is usually handed a whole /64, so keying on the
 *     full address would give one bot 2^64 fresh allowances.
 *   - null, or anything that is not an address: ONE shared key. Deliberately
 *     strict — an address the adapter cannot read must not be a way around the cap.
 *
 * The key is only as trustworthy as the address it is built from. Behind a proxy
 * that means ADDRESS_HEADER and XFF_DEPTH must be set, which env.ts enforces in
 * production.
 */
export function signupAddressKey(ip: string | null): string {
	if (!ip) return UNKNOWN;
	const address = ip.trim();

	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	if (mapped && isIP(mapped[1]) === 4) return mapped[1];

	switch (isIP(address)) {
		case 4:
			return address;
		case 6:
			return ipv6Slash64(address);
		default:
			return UNKNOWN;
	}
}

/** The first four hextets of a valid IPv6 address, normalised, as `a:b:c:d::/64`. */
function ipv6Slash64(address: string): string {
	const [withoutZone] = address.toLowerCase().split('%');
	const doubleColon = withoutZone.indexOf('::');
	let full: string[];
	if (doubleColon === -1) {
		full = hextets(withoutZone);
	} else {
		const head = hextets(withoutZone.slice(0, doubleColon));
		const tail = hextets(withoutZone.slice(doubleColon + 2));
		const zeros = Array<string>(8 - head.length - tail.length).fill('0');
		full = [...head, ...zeros, ...tail];
	}
	return (
		full
			.slice(0, 4)
			.map((h) => parseInt(h, 16).toString(16))
			.join(':') + '::/64'
	);
}

/** Split one side of `::` into hextets. An embedded dotted IPv4 fills two. */
function hextets(part: string): string[] {
	if (part === '') return [];
	return part.split(':').flatMap((p) => (p.includes('.') ? ['0', '0'] : [p]));
}
