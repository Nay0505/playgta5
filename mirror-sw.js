'use strict';

const DB_NAME = 'gta5-local-mirror';
const BUILD = '/b/8b0b5899ed/';
const SERVER_FILES = new Set(['loader.js', 'game.js', 'io_worker.js', 'wgpu_worker.js']);
let mirrorHandle = null;

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore('handles');
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function storedHandle() {
	if (mirrorHandle) return mirrorHandle;
	const db = await openDb();
	const handle = await new Promise((resolve, reject) => {
		const request = db.transaction('handles', 'readonly').objectStore('handles').get('root');
		request.onsuccess = () => resolve(request.result || null);
		request.onerror = () => reject(request.error);
	});
	if (handle) mirrorHandle = handle;
	return handle;
}

function headersFor(file, extra = {}) {
	const headers = new Headers(extra);
	headers.set('Content-Type', file.type || mimeType(file.name));
	headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	headers.set('Accept-Ranges', 'bytes');
	return headers;
}

function mimeType(name) {
	return ({ '.wasm': 'application/wasm', '.js': 'text/javascript', '.json': 'application/json', '.wgsl': 'text/plain', '.woff': 'font/woff', '.png': 'image/png', '.webp': 'image/webp' })[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
}

function safeParts(path) {
	const parts = path.split('/');
	if (!path || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid asset path');
	return parts;
}

async function getFile(relative) {
	const parts = safeParts(relative);
	let directory = await (await storedHandle()).getDirectoryHandle('playgta5.com');
	for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
	return directory.getFileHandle(parts[parts.length - 1]).then((handle) => handle.getFile());
}

async function localPath(url) {
	let path;
	try { path = decodeURIComponent(url.pathname); } catch { return null; }
	if (path.startsWith('/data/')) return path.slice(1);
	if (!path.startsWith(BUILD)) return null;
	const relative = path.slice(BUILD.length);
	if (SERVER_FILES.has(relative)) return null;
	if (relative === 'game.wasm' || relative === 'audio-worklet.js' || relative.startsWith('shaders/') || relative.startsWith('title/'))
		return 'b/8b0b5899ed/' + relative;
	return null;
}

async function assetResponse(request, relative) {
	const root = await storedHandle();
	if (!root) return new Response('Select the mirror folder first.', { status: 503 });
	if (await root.queryPermission({ mode: 'read' }) !== 'granted') return new Response('Mirror folder access expired. Reload and select it again.', { status: 403 });
	const file = await getFile(relative);
	const range = request.headers.get('Range');
	if (!range) return new Response(file.stream(), { status: 200, headers: headersFor(file, { 'Content-Length': file.size }) });
	const match = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: headersFor(file, { 'Content-Range': 'bytes */' + file.size }) });
	const start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
	const end = match[1] && match[2] ? Math.min(file.size - 1, Number(match[2])) : file.size - 1;
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.size || end < start)
		return new Response(null, { status: 416, headers: headersFor(file, { 'Content-Range': 'bytes */' + file.size }) });
	const length = end - start + 1;
	return new Response(file.slice(start, end + 1).stream(), { status: 206, headers: headersFor(file, {
		'Content-Length': length,
		'Content-Range': 'bytes ' + start + '-' + end + '/' + file.size,
	}) });
}

async function batchResponse(request) {
	const runs = await request.json();
	if (!Array.isArray(runs) || runs.length > 1000) return new Response('Invalid batch', { status: 400 });
	const blobs = [], lengths = [];
	let total = 0;
	for (const run of runs) {
		if (!Array.isArray(run) || run.length !== 3 || typeof run[0] !== 'string' || !Number.isSafeInteger(run[1]) || !Number.isSafeInteger(run[2]) || run[1] < 0 || run[2] < run[1])
			return new Response('Invalid batch range', { status: 400 });
		const file = await getFile('data/' + run[0]);
		const start = run[1], end = Math.min(run[2] + 1, file.size);
		const length = Math.max(0, end - start);
		total += length;
		if (total > 64 * 1024 * 1024) return new Response('Batch exceeds 64 MiB', { status: 413 });
		blobs.push(file.slice(start, end));
		lengths.push(length);
	}
	return new Response(new Blob(blobs).stream(), { status: 200, headers: {
		'Content-Type': 'application/octet-stream',
		'Content-Length': total,
		'X-Run-Lengths': lengths.join(','),
		'Cross-Origin-Resource-Policy': 'same-origin',
	} });
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'set-mirror') {
		mirrorHandle = event.data.handle;
		event.ports[0].postMessage({ ok: true });
	}
});
self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname === '/data/batch' && event.request.method === 'POST') {
		event.respondWith(batchResponse(event.request).catch((error) => new Response(error.message, { status: 400 })));
		return;
	}
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return;
	event.respondWith((async () => {
		const path = await localPath(url);
		if (!path) return fetch(event.request);
		try { return await assetResponse(event.request, path); }
		catch (error) { return new Response('Mirror asset not found: ' + path, { status: 404, headers: { 'Content-Type': 'text/plain' } }); }
	})());
});