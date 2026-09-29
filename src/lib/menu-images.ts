// MENU PHOTO LIMITS AND URLS — ISOMORPHIC, and it imports NOTHING (the same
// rule as src/lib/money and src/lib/sync-ops): the dashboard's browser-side
// resizer, the /menu actions, the menu module, the two image routes and the
// till all read these numbers from here, so they cannot drift.
//
// IMAGE_MAX_BYTES = 409,600. adapter-node refuses a request body above
// BODY_SIZE_LIMIT, whose default is '512K' = 524,288 bytes
// (node_modules/@sveltejs/adapter-node/files/handler.js), and a multipart
// upload adds framing bytes around the file; Nginx's client_max_body_size
// default is 1m. 400 KB leaves ~112 KB of headroom under the tighter of the two,
// so a photo that passes the browser-side resize cannot be refused at the door
// in production (tasks/menu-and-printing, risk "uploads that pass every test and
// fail in production"). The database CHECK menu_images_byte_size_range carries
// the same number.
//
// IMAGE_MAX_EDGE = 1024: the longer edge a photo is scaled to before encoding. A
// menu tile is far smaller, and 1024 px keeps a JPEG or WebP well under the cap.
//
// IMAGE_CONTENT_TYPES: JPEG, PNG and WebP — raster formats a browser decodes
// into pixels and nothing else. SVG is deliberately absent: it is a DOCUMENT that
// can carry script and external references, and a menu photo is a picture. The
// server decides the type by MAGIC BYTES (sniffImageType in
// src/lib/server/menu/images.ts), never by the client's declared MIME type or
// the file's extension.

export const IMAGE_MAX_BYTES = 409_600;
export const IMAGE_MAX_EDGE = 1024;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** Where the till fetches a photo's bytes (requireDevice; served immutable, private). */
export function tillImageUrl(imageId: string): string {
	return `/api/menu/images/${imageId}`;
}

/** Where the dashboard fetches a photo's bytes (admin.menu; served immutable, private). */
export function dashboardImageUrl(imageId: string): string {
	return `/menu/images/${imageId}`;
}
