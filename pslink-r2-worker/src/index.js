/**
 * PSLink R2 Proxy Worker
 *
 * Endpoints:
 *   GET  /health           — connection test
 *   PUT  /upload           — receive encrypted blob → write to R2
 *   POST /download         — return encrypted blob from R2
 *   POST /delete           — delete objects from R2
 *   GET  /yahoo?symbol=…   — CORS proxy for Yahoo Finance chart API (replaces dead allorigins.win)
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
			// Validate key format:
			//   muse/{a-f}/{hash}.enc.{webm|jpg}  — Muse video clips + thumbnails
			//   profile/{name}.enc.jpg            — avatar / profile photos
			//   psup/{model}.enc.onnx             — PS Upscaler ONNX models (added 2026-05-05)
			if (!/^(muse\/[a-f]\/[a-f0-9]+\.enc\.(webm|jpg)|profile\/[a-z0-9-]+\.enc\.jpg|psup\/[A-Za-z0-9._-]+\.enc\.onnx)$/.test(r2Key)) {
				return errorResponse('Invalid key format');
			}
			const body = await request.arrayBuffer();
			if (!body || body.byteLength === 0) {
				return errorResponse('Empty body');
			}
			// Size cap: 100 MB (PSUP models 49-67 MB encrypted; Cloudflare Worker free-tier max body 100 MB)
			if (body.byteLength > 100 * 1024 * 1024) {
				return errorResponse('File too large (max 100 MB)', 413);
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

		// GET /yahoo?symbol=^GSPC — CORS proxy for Yahoo Finance v8 chart API
		// Symbol must already be URL-encoded by caller (e.g. %5EGSPC for ^GSPC, GC%3DF for GC=F)
		if (path === '/yahoo' && request.method === 'GET') {
			const symbol = url.searchParams.get('symbol');
			if (!symbol) return errorResponse('Missing symbol param');
			let decoded;
			try { decoded = decodeURIComponent(symbol); } catch (e) { return errorResponse('Invalid symbol encoding'); }
			if (!/^[A-Z0-9.\-=^]{1,16}$/i.test(decoded)) return errorResponse('Invalid symbol format');
			const interval = url.searchParams.get('interval') || '1d';
			const range = url.searchParams.get('range') || '1d';
			if (!/^[0-9a-z]{1,4}$/.test(interval) || !/^[0-9a-z]{1,4}$/.test(range)) return errorResponse('Invalid interval/range');
			const upstream = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(decoded)}?interval=${interval}&range=${range}`;
			try {
				const res = await fetch(upstream, {
					headers: {
						'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
						'Accept': 'application/json',
					},
					cf: { cacheTtl: 60, cacheEverything: true },
				});
				if (!res.ok) return errorResponse(`Yahoo upstream ${res.status}`, 502);
				const data = await res.text();
				return corsResponse(data, {
					status: 200,
					headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
				});
			} catch (e) {
				return errorResponse(`Yahoo proxy failed: ${e.message}`, 502);
			}
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
