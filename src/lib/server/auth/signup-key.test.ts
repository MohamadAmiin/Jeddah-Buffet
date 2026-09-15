import { describe, it, expect } from 'vitest';
import { signupAddressKey } from './signup-key';

describe('signupAddressKey', () => {
	it('keys an IPv4 address by itself', () => {
		expect(signupAddressKey('203.0.113.9')).toBe('203.0.113.9');
		expect(signupAddressKey('  203.0.113.9 ')).toBe('203.0.113.9');
	});

	it('unwraps an IPv4-mapped IPv6 address, so one visitor is one key', () => {
		expect(signupAddressKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
		expect(signupAddressKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
	});

	it('groups IPv6 addresses by their /64', () => {
		expect(signupAddressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
		expect(signupAddressKey('2001:db8:1:2:ffff::1')).toBe('2001:db8:1:2::/64');
		expect(signupAddressKey('2001:0DB8:0001:0002::1')).toBe('2001:db8:1:2::/64');
	});

	it('expands :: when it falls inside the first four hextets', () => {
		expect(signupAddressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
		expect(signupAddressKey('::1')).toBe('0:0:0:0::/64');
		expect(signupAddressKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
	});

	it('keeps different /64s apart', () => {
		expect(signupAddressKey('2001:db8:1:2::1')).not.toBe(signupAddressKey('2001:db8:1:3::1'));
	});

	it('collapses a missing or unreadable address into ONE shared key', () => {
		expect(signupAddressKey(null)).toBe('unknown');
		expect(signupAddressKey('')).toBe('unknown');
		expect(signupAddressKey('not-an-address')).toBe('unknown');
		expect(signupAddressKey('999.1.1.1')).toBe('unknown');
	});
});
