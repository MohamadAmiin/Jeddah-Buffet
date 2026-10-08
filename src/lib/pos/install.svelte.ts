// INSTALLING THE TILL AS AN APP — the browser's own "install this site" flow,
// which gives the POS its own window and icon, no address bar, and a cold start
// from the precached shell when the network is down. Nothing is downloaded from
// matcami: the manifest at static/pos.webmanifest describes the app and the
// browser does the installing. There is no packaged installer to host, sign or
// update (decision of 2026-10-08; a wrapped native app is a separate decision).
//
// Two browser families, two paths:
//   - Chromium (Chrome, Edge, Android) fires `beforeinstallprompt` once the site
//     meets its criteria — a manifest, a registered service worker and HTTPS. The
//     event must be CAPTURED, or the browser shows its own banner at a moment of
//     its choosing; captured, it is replayed from a button the person taps.
//   - Safari on iPhone and iPad has no prompt: the person uses Share → Add to Home
//     Screen, so the screen SAYS so instead of showing a dead button.
// Firefox installs nothing on desktop; the screen stays quiet there rather than
// promising a thing the browser cannot do.
//
// This module imports nothing from $lib/server (it runs offline) and touches the
// DOM only inside the functions the shell calls after mount.

/** The subset of Chromium's BeforeInstallPromptEvent the till uses. */
export type InstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

/** What the sign-in screen shows. A $state box, like employee.svelte.ts: a
 * reassigned $state variable cannot be exported from a module. */
export const installable = $state<{ prompt: InstallPromptEvent | null; standalone: boolean }>({
	prompt: null,
	standalone: false
});

export type InstallState = 'installed' | 'prompt' | 'manual-ios' | 'unavailable';

/**
 * THE rule for what the sign-in screen offers, pure so a test can walk every
 * combination. `standalone` wins: an installed app never advertises installing
 * itself. Then a captured prompt; then iOS's manual path, which is only worth
 * describing on a secure origin (an http:// page cannot be added as an app
 * either); otherwise nothing.
 */
export function installStateFor(args: {
	standalone: boolean;
	promptAvailable: boolean;
	ios: boolean;
	secure: boolean;
}): InstallState {
	if (args.standalone) return 'installed';
	if (args.promptAvailable) return 'prompt';
	if (args.ios && args.secure) return 'manual-ios';
	return 'unavailable';
}

/**
 * iPhone and iPad. iPadOS 13+ reports a Macintosh user agent, so a Mac with touch
 * points is an iPad — a real Mac reports none. Pure: the caller passes the values.
 */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
	if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
	return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Whether the page is running as an installed app rather than in a tab. */
function runningStandalone(): boolean {
	if (typeof matchMedia !== 'function') return false;
	return (
		matchMedia('(display-mode: standalone)').matches ||
		matchMedia('(display-mode: fullscreen)').matches ||
		// Safari's pre-standard flag.
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

/**
 * Called ONCE by the POS shell after mount. Captures Chromium's install prompt,
 * records whether the till already runs installed, and forgets the prompt once
 * the app is installed. Returns the cleanup for the shell's onMount.
 */
export function captureInstallPrompt(): () => void {
	installable.standalone = runningStandalone();
	const onPrompt = (event: Event) => {
		// Hold the browser's own banner back; the sign-in screen offers it instead.
		event.preventDefault();
		installable.prompt = event as InstallPromptEvent;
	};
	const onInstalled = () => {
		installable.prompt = null;
		installable.standalone = true;
	};
	addEventListener('beforeinstallprompt', onPrompt);
	addEventListener('appinstalled', onInstalled);
	return () => {
		removeEventListener('beforeinstallprompt', onPrompt);
		removeEventListener('appinstalled', onInstalled);
	};
}

/**
 * Replay the captured prompt from a tap. A prompt can be shown ONCE: whatever
 * the person chooses, it is dropped, and Chromium fires a fresh
 * beforeinstallprompt later if the site still qualifies.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'none'> {
	const prompt = installable.prompt;
	if (prompt === null) return 'none';
	installable.prompt = null;
	try {
		await prompt.prompt();
		const choice = await prompt.userChoice;
		return choice.outcome;
	} catch {
		return 'none';
	}
}
