import { describe, it, expect } from 'vitest';
import { installStateFor, isIos } from './install.svelte';

describe('installStateFor — what the sign-in screen offers', () => {
	it('an installed app never advertises installing itself, whatever else is true', () => {
		expect(
			installStateFor({ standalone: true, promptAvailable: true, ios: true, secure: true })
		).toBe('installed');
		expect(
			installStateFor({ standalone: true, promptAvailable: false, ios: false, secure: false })
		).toBe('installed');
	});

	it('offers the captured prompt whenever the browser handed one over', () => {
		expect(
			installStateFor({ standalone: false, promptAvailable: true, ios: false, secure: true })
		).toBe('prompt');
		// A prompt is the browser's word that the site qualifies, so it wins over the
		// iOS guess.
		expect(
			installStateFor({ standalone: false, promptAvailable: true, ios: true, secure: true })
		).toBe('prompt');
	});

	it('describes Share → Add to Home Screen on iOS, but only on a secure origin', () => {
		expect(
			installStateFor({ standalone: false, promptAvailable: false, ios: true, secure: true })
		).toBe('manual-ios');
		expect(
			installStateFor({ standalone: false, promptAvailable: false, ios: true, secure: false })
		).toBe('unavailable');
	});

	it('stays quiet in a browser that cannot install (Firefox desktop, plain http)', () => {
		expect(
			installStateFor({ standalone: false, promptAvailable: false, ios: false, secure: true })
		).toBe('unavailable');
		expect(
			installStateFor({ standalone: false, promptAvailable: false, ios: false, secure: false })
		).toBe('unavailable');
	});
});

describe('isIos', () => {
	const IPHONE =
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
	const IPAD_AS_MAC =
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
	const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';

	it('recognises an iPhone by its user agent', () => {
		expect(isIos(IPHONE, 5)).toBe(true);
	});

	it('recognises an iPad that reports itself as a Mac by its touch points', () => {
		expect(isIos(IPAD_AS_MAC, 5)).toBe(true);
		// A real Mac has no touch points.
		expect(isIos(IPAD_AS_MAC, 0)).toBe(false);
	});

	it('is false for a desktop browser', () => {
		expect(isIos(FIREFOX_LINUX, 0)).toBe(false);
	});
});
