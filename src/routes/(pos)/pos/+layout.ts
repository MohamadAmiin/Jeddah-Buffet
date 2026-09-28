// The till renders in the browser only. The service worker keeps ONE cached shell
// document (/pos) and serves it for every /pos/... navigation when the network is
// down. A server-rendered shell would carry /pos's route with it, so an offline
// reload of /pos/order would hydrate as employee-select — whose mount signs the
// cashier out. Client-only rendering lets that one document route by URL.
// This is page config, not a load: nothing here blocks on the server.
export const ssr = false;
