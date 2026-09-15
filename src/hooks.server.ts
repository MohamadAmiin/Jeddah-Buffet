import { error, redirect, type Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { db } from '$lib/server/db/client';
import { PUBLIC_ROUTE_IDS } from '$lib/public-routes';
import { THEME_COOKIE, parseTheme, themeAttribute } from '$lib/theme';
import {
	SESSION_COOKIE,
	validateSessionToken,
	setSessionCookie,
	deleteSessionCookie
} from '$lib/server/auth/session';

// The allow-list lives in $lib/public-routes so T-20's static walk can read it
// without pulling in the database client and $env. Re-exported here because this
// is where it is ENFORCED.
//
// The inversion matters. A guard that protected only /(dashboard) would leave
// every future top-level route public unless it remembered its own check — and
// this plan already puts /logout at top level, with spec 7's device registration
// to come beside it.
export { PUBLIC_ROUTE_IDS } from '$lib/public-routes';

// The theme preference, read from a cookie and stamped on <html> BEFORE the first
// byte reaches the browser — which is the whole reason a cookie was chosen over
// localStorage: there is no flash of the wrong theme.
//
// It does NOT read event.locals: it runs before the session is resolved, and a
// theme is not a privilege. It adds no route, no form action, no PUBLIC_ROUTE_IDS
// entry and no permission key — the cookie is written by client JavaScript
// (ThemeToggle) and only READ here.
//
// The placeholder is ALWAYS replaced, including in the system state where it is
// replaced with an empty string. Branch on the cookie instead and the literal text
// %matcami.theme% ships inside the <html> tag of every page — which is why
// themeAttribute takes Theme | null and returns a string in all cases.
//
// String.replace with a string argument replaces only the FIRST occurrence. That is
// correct here and src/lib/theme.test.ts pins the placeholder at exactly one. Under
// streaming, transformPageChunk runs per chunk; the placeholder sits in the first
// chunk, so later chunks are a harmless no-op.
export const handleTheme: Handle = async ({ event, resolve }) => {
	const theme = parseTheme(event.cookies.get(THEME_COOKIE));
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%matcami.theme%', themeAttribute(theme))
	});
};

/** Route ids under this prefix additionally require the owner role. */
const DASHBOARD_PREFIX = '/(dashboard)';

function isDashboardRoute(routeId: string | null): boolean {
	// Route GROUP names are part of event.route.id — the generated types in
	// .svelte-kit/types contain "/(dashboard)" and "/(pos)".
	return routeId !== null && routeId.startsWith(DASHBOARD_PREFIX);
}

// Exported individually so route-guards.integration.test.ts can drive the REAL
// handlers. `sequence` relies on SvelteKit's internal request store, which only
// exists inside a real request — composing these two by hand is the only way to
// test the actual hook rather than a re-implementation of it.
export const handleSession: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.restaurantId = null;
	event.locals.sessionToken = null;
	event.locals.posDevice = null;

	const token = event.cookies.get(SESSION_COOKIE);
	if (!token) return resolve(event);

	const dashboard = isDashboardRoute(event.route.id);

	const principal = await validateSessionToken(db, token);
	if (!principal) {
		deleteSessionCookie(event.cookies);
		return resolve(event);
	}

	event.locals.user = principal;
	event.locals.sessionToken = token;

	// restaurantId is set for DASHBOARD ROUTES ONLY, and that is deliberate. A
	// future POS or sync route must resolve its tenant from the registered device
	// row and its actor from the queued operation, never from whichever owner last
	// logged in on this browser. Leaving it null elsewhere means such a route fails
	// loudly the first time somebody wires it to locals by habit, instead of
	// silently posting one restaurant's sales under another restaurant's id.
	if (dashboard) {
		event.locals.restaurantId = principal.restaurantId;

		// Re-set the cookie when validateSessionToken slid the expiry, so the sliding
		// window actually reaches the browser. Sliding on DASHBOARD requests only:
		// an owner's cookie left on a counter tablet must not renew itself forever
		// through POS or asset traffic.
		setSessionCookie(event.cookies, token, principal.expiresAt);
	}

	return resolve(event);
};

export const handleGuard: Handle = async ({ event, resolve }) => {
	const routeId = event.route.id;

	// No route matched — leave it alone for SvelteKit to 404.
	if (routeId === null) return resolve(event);

	const user = event.locals.user;

	// Widened to string on purpose: event.route.id is typed as a union of the
	// routes that CURRENTLY exist, so comparing it against '/login' before T-18
	// creates that route is a type error rather than a logic error.
	const id: string = routeId;

	if (PUBLIC_ROUTE_IDS.has(id)) {
		// A signed-in visitor has no business on the login or registration page.
		if (user && (id === '/login' || id === '/register')) {
			redirect(303, '/dashboard');
		}
		return resolve(event);
	}

	// DENY BY DEFAULT.
	if (!user) {
		const next = encodeURIComponent(event.url.pathname + event.url.search);
		redirect(303, `/login?next=${next}`);
	}

	if (isDashboardRoute(routeId) && user.role !== 'owner') {
		// 403, not 404. Spec 8: "the server returns 403 Forbidden. So hiding buttons
		// in the frontend is not considered security."
		error(403, 'Forbidden');
	}

	return resolve(event);
};

// (pos) and /api are in NEITHER list yet, on purpose. When those surfaces arrive
// they authenticate by registered device and employee PIN rather than by this
// cookie, and the deny-by-default rule forces them to be added here deliberately,
// with their own tenant and actor resolution.
//
// The origin/CSRF check is NOT configured anywhere: SvelteKit's default is on and
// invariant 12 requires it stay on. If a production deployment returns 403 on form
// posts, the fix is the ORIGIN environment variable for adapter-node, which T-26
// documents — never disabling the check.
//
// PROXY DEPENDENCY, recorded where the locals are built: event.getClientAddress()
// returns the socket peer unless ADDRESS_HEADER is set, so behind Nginx every
// audit row and every throttle bucket sees 127.0.0.1 until T-26's variables are
// configured. That degrades SILENTLY, which is why it is written down here.
export const handle = sequence(handleTheme, handleSession, handleGuard);
