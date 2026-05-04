/**
 * PSLink R2 Proxy Worker
 *
 * Endpoints:
 *   GET  /health           — connection test
 *   PUT  /upload           — receive encrypted blob → write to R2
 *   POST /download         — return encrypted blob from R2
 *   POST /delete           — delete objects from R2
 *
 * Auth: Authorization: Bearer <R2_AUTH_TOKEN> on every request
 * R2 binding: MEDIA_BUCKET (set in wrangler.toml)
 */

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-R2-Key',
	'Access-Control-Expose-Headers': 'ETag',
	'Access-Control-Max-Age': '86400',
};

function corsResponse(body, init = {}) {
	const headers = { ...CORS_HEADERS, ...(init.headers || {}) };
	return new Response(body, { ...init, headers });
}

function jsonResponse(data, status = 200) {
	return corsResponse(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function errorResponse(message, status = 400) {
	return jsonResponse({ error: message }, status);
}

export default {
	async fetch(request, env) {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return corsResponse(null, { status: 204 });
		}

		const url = new URL(request.url);
		const path = url.pathname;

		// Health check (no auth required)
		if (path === '/health' && request.method === 'GET') {
			return jsonResponse({ status: 'ok', bucket: 'pslink-media' });
		}

		// All other endpoints require auth
		const authHeader = request.headers.get('Authorization') || '';
		const token = authHeader.replace(/^Bearer\s+/i, '');
		if (!token || token !== env.R2_AUTH_TOKEN) {
			return errorResponse('Unauthorized', 401);
		}

		// PUT /upload — receive encrypted blob, write to R2
		if (path === '/upload' && request.method === 'PUT') {
			const r2Key = request.headers.get('X-R2-Key');
			if (!r2Key || r2Key.length > 256) {
				return errorResponse('Missing or invalid X-R2-Key header');
			}
			// Validate key format: muse/{a-f}/{hash}.enc.{ext} or profile/{name}.enc.jpg
			if (!/^(muse\/[a-f]\/[a-f0-9]+|profile\/[a-z0-9-]+)\.enc\.(webm|jpg)$/.test(r2Key)) {
				return errorResponse('Invalid key format');
			}
			const body = await request.arrayBuffer();
			if (!body || body.byteLength === 0) {
				return errorResponse('Empty body');
			}
			if (body.byteLength > 10 * 1024 * 1024) { // 10 MB limit
				return errorResponse('File too large (max 10 MB)', 413);
			}
			await env.MEDIA_BUCKET.put(r2Key, body, {
				httpMetadata: { contentType: 'application/octet-stream' },
			});
			return jsonResponse({ ok: true, key: r2Key, size: body.byteLength });
		}

		// POST /download — return encrypted blob from R2
		if (path === '/download' && request.method === 'POST') {
			let reqBody;
			try { reqBody = await request.json(); } catch (e) {
				return errorResponse('Invalid JSON body');
			}
			const r2Key = reqBody.key;
			if (!r2Key || typeof r2Key !== 'string') {
				return errorResponse('Missing key in body');
			}
			const object = await env.MEDIA_BUCKET.get(r2Key);
			if (!object) {
				return errorResponse('Not found', 404);
			}
			return corsResponse(object.body, {
				status: 200,
				headers: {
					'Content-Type': 'application/octet-stream',
					'Content-Length': object.size.toString(),
					'ETag': object.etag,
				},
			});
		}

		// POST /delete — delete objects from R2
		if (path === '/delete' && request.method === 'POST') {
			let reqBody;
			try { reqBody = await request.json(); } catch (e) {
				return errorResponse('Invalid JSON body');
			}
			const keys = reqBody.keys;
			if (!Array.isArray(keys) || keys.length === 0) {
				return errorResponse('Missing keys array in body');
			}
			if (keys.length > 50) {
				return errorResponse('Max 50 keys per request');
			}
			const results = [];
			for (const key of keys) {
				if (typeof key === 'string' && key.length > 0 && key.length <= 256) {
					await env.MEDIA_BUCKET.delete(key);
					results.push({ key, deleted: true });
				}
			}
			return jsonResponse({ ok: true, results });
		}

		return errorResponse('Not found', 404);
	},
};
