/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	AssetOptimizationEntry,
	AssetOptimizationReport,
	DownloadedVisualAsset,
	IDesignAssetMainService,
	ImageProviderName,
	ProviderSearchStatus,
	VisualAssetCandidate,
	VisualAssetSearchResult,
	VisualRevisionComparison,
} from '../common/designIntelligenceTypes.js';

const USER_AGENT = 'KodiaDesignEngine/1.0 (+https://kodia.dev)';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024; // 12 MB safety ceiling

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
	if (!workspaceRoot) { return false; }
	const resolvedRoot = path.resolve(workspaceRoot);
	const resolvedTarget = path.resolve(targetPath);
	const rel = path.relative(resolvedRoot, resolvedTarget);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizeFilename(name: string, fallbackExt = '.jpg'): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (!cleaned) { return `asset-${Date.now().toString(36)}${fallbackExt}`; }
	if (!/\.(png|jpe?g|webp|avif|gif|svg)$/i.test(cleaned)) {
		return `${cleaned}${fallbackExt}`;
	}
	return cleaned;
}

function extFromMime(mime: string): string {
	const m = mime.toLowerCase();
	if (m.includes('png')) { return '.png'; }
	if (m.includes('webp')) { return '.webp'; }
	if (m.includes('svg')) { return '.svg'; }
	if (m.includes('gif')) { return '.gif'; }
	if (m.includes('avif')) { return '.avif'; }
	return '.jpg';
}

/**
 * Inspects image binary header (PNG, JPEG, GIF, WebP, SVG) to extract real dimensions without external dependencies.
 */
export function inspectImageDimensions(buf: Buffer, extOrMime: string): { width?: number; height?: number; format: string } {
	const lower = extOrMime.toLowerCase();
	// PNG signature: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at offset 16..23
	if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
	}
	// GIF signature: GIF87a or GIF89a
	if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
		return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
	}
	// WebP signature: RIFF....WEBP
	if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
		const chunk = buf.toString('ascii', 12, 16);
		if (chunk === 'VP8X' && buf.length >= 30) {
			const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
			const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
			return { width: w, height: h, format: 'webp' };
		}
		return { format: 'webp' };
	}
	// JPEG SOF0/SOF2 marker scan
	if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
		let offset = 2;
		while (offset + 9 < buf.length) {
			if (buf[offset] !== 0xFF) { break; }
			const marker = buf[offset + 1];
			if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
				const height = buf.readUInt16BE(offset + 5);
				const width = buf.readUInt16BE(offset + 7);
				return { width, height, format: 'jpeg' };
			}
			if (marker === 0xD9 || marker === 0xDA) { break; }
			const segLen = buf.readUInt16BE(offset + 2);
			if (segLen < 2) { break; }
			offset += 2 + segLen;
		}
		return { format: 'jpeg' };
	}
	// SVG text inspection
	if (lower.includes('svg') || buf.toString('utf8', 0, Math.min(256, buf.length)).includes('<svg')) {
		const head = buf.toString('utf8', 0, Math.min(2048, buf.length));
		const vb = /viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(head);
		if (vb) {
			return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])), format: 'svg' };
		}
		const wM = /\bwidth\s*=\s*["']([\d.]+)/i.exec(head);
		const hM = /\bheight\s*=\s*["']([\d.]+)/i.exec(head);
		return {
			width: wM ? Math.round(Number(wM[1])) : undefined,
			height: hM ? Math.round(Number(hM[1])) : undefined,
			format: 'svg',
		};
	}
	return { format: lower.replace(/^\./, '') || 'unknown' };
}

function generateBespokeSvgArtwork(opts: {
	subject: string;
	primaryColor?: string;
	secondaryColor?: string;
	accentColor?: string;
	width?: number;
	height?: number;
	style?: 'abstract' | 'editorial' | 'product-backdrop' | 'mesh-gradient' | 'geometric';
}): string {
	const w = Math.max(160, Math.min(2400, opts.width ?? 1200));
	const h = Math.max(120, Math.min(2400, opts.height ?? 800));
	const p = /^#[0-9a-fA-F]{3,6}$/.test(opts.primaryColor ?? '') ? opts.primaryColor! : '#1E293B';
	const s = /^#[0-9a-fA-F]{3,6}$/.test(opts.secondaryColor ?? '') ? opts.secondaryColor! : '#334155';
	const a = /^#[0-9a-fA-F]{3,6}$/.test(opts.accentColor ?? '') ? opts.accentColor! : '#6366F1';
	const safeLabel = opts.subject.replace(/[<>&"']/g, '').slice(0, 80);
	const style = opts.style ?? 'editorial';

	const geometricLayer = style === 'geometric'
		? `<g opacity="0.22" stroke="${a}" stroke-width="1.5" fill="none">
    <rect x="${Math.round(w * 0.1)}" y="${Math.round(h * 0.14)}" width="${Math.round(w * 0.34)}" height="${Math.round(h * 0.62)}" rx="4"/>
    <circle cx="${Math.round(w * 0.68)}" cy="${Math.round(h * 0.48)}" r="${Math.round(Math.min(w, h) * 0.28)}"/>
    <line x1="0" y1="${Math.round(h * 0.78)}" x2="${w}" y2="${Math.round(h * 0.24)}"/>
  </g>`
		: style === 'product-backdrop'
			? `<ellipse cx="${Math.round(w * 0.5)}" cy="${Math.round(h * 0.82)}" rx="${Math.round(w * 0.36)}" ry="${Math.round(h * 0.08)}" fill="${p}" opacity="0.25"/>
  <rect x="${Math.round(w * 0.22)}" y="${Math.round(h * 0.16)}" width="${Math.round(w * 0.56)}" height="${Math.round(h * 0.62)}" rx="12" fill="url(#cardSheen)" stroke="${a}" stroke-opacity="0.24"/>`
			: `<circle cx="${Math.round(w * 0.22)}" cy="${Math.round(h * 0.26)}" r="${Math.round(Math.min(w, h) * 0.42)}" fill="url(#orb1)"/>
  <circle cx="${Math.round(w * 0.78)}" cy="${Math.round(h * 0.72)}" r="${Math.round(Math.min(w, h) * 0.46)}" fill="url(#orb2)"/>
  <path d="M0 ${Math.round(h * 0.72)} Q ${Math.round(w * 0.35)} ${Math.round(h * 0.48)} ${Math.round(w * 0.68)} ${Math.round(h * 0.64)} T ${w} ${Math.round(h * 0.42)} L ${w} ${h} L 0 ${h} Z" fill="${p}" opacity="0.18"/>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${safeLabel}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${p}"/>
      <stop offset="55%" stop-color="${s}"/>
      <stop offset="100%" stop-color="${p}"/>
    </linearGradient>
    <radialGradient id="orb1" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${a}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${a}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb2" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${s}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${p}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cardSheen" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bgGrad)"/>
  ${geometricLayer}
</svg>`;
}

// ============================================================================
// PURE-NODE PNG DECODER / ENCODER FOR REAL PIXEL-LEVEL VISUAL REVISION DIFFING
// ============================================================================

interface DecodedPng {
	readonly width: number;
	readonly height: number;
	readonly rgba: Uint8Array;
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) { return a; }
	if (pb <= pc) { return b; }
	return c;
}

export function decodePngToRgba(buf: Buffer): DecodedPng {
	if (buf.length < 33 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
		throw new Error('File is not a valid PNG image.');
	}
	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 8;
	let colorType = 6;
	let interlace = 0;
	let palette: Buffer | null = null;
	const idatChunks: Buffer[] = [];

	while (offset + 12 <= buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString('ascii', offset + 4, offset + 8);
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		if (dataEnd + 4 > buf.length) { break; }
		const chunk = buf.subarray(dataStart, dataEnd);
		if (type === 'IHDR') {
			width = chunk.readUInt32BE(0);
			height = chunk.readUInt32BE(4);
			bitDepth = chunk[8];
			colorType = chunk[9];
			interlace = chunk[12];
		} else if (type === 'PLTE') {
			palette = chunk;
		} else if (type === 'IDAT') {
			idatChunks.push(chunk);
		} else if (type === 'IEND') {
			break;
		}
		offset = dataEnd + 4;
	}

	if (width <= 0 || height <= 0 || idatChunks.length === 0) {
		throw new Error('PNG missing IHDR or IDAT chunks.');
	}
	if (bitDepth !== 8 || interlace !== 0) {
		throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, interlace=${interlace}); expected 8-bit non-interlaced PNG.`);
	}

	const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : (colorType === 0 || colorType === 3) ? 1 : 0;
	if (bpp === 0) {
		throw new Error(`Unsupported PNG colorType=${colorType}.`);
	}

	const raw = zlib.inflateSync(Buffer.concat(idatChunks));
	const stride = width * bpp;
	const recon = new Uint8Array(height * stride);
	let srcPos = 0;

	for (let y = 0; y < height; y++) {
		const filter = raw[srcPos++];
		const rowOffset = y * stride;
		for (let x = 0; x < stride; x++) {
			const val = raw[srcPos++];
			const a = x >= bpp ? recon[rowOffset + x - bpp] : 0;
			const b = y > 0 ? recon[rowOffset - stride + x] : 0;
			const c = (x >= bpp && y > 0) ? recon[rowOffset - stride + x - bpp] : 0;
			let out = val;
			if (filter === 1) { out = (val + a) & 0xFF; }
			else if (filter === 2) { out = (val + b) & 0xFF; }
			else if (filter === 3) { out = (val + ((a + b) >> 1)) & 0xFF; }
			else if (filter === 4) { out = (val + paethPredictor(a, b, c)) & 0xFF; }
			recon[rowOffset + x] = out;
		}
	}

	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const dst = i * 4;
		if (colorType === 6) {
			rgba[dst] = recon[dst];
			rgba[dst + 1] = recon[dst + 1];
			rgba[dst + 2] = recon[dst + 2];
			rgba[dst + 3] = recon[dst + 3];
		} else if (colorType === 2) {
			const s = i * 3;
			rgba[dst] = recon[s];
			rgba[dst + 1] = recon[s + 1];
			rgba[dst + 2] = recon[s + 2];
			rgba[dst + 3] = 255;
		} else if (colorType === 4) {
			const s = i * 2;
			rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = recon[s];
			rgba[dst + 3] = recon[s + 1];
		} else if (colorType === 0) {
			rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = recon[i];
			rgba[dst + 3] = 255;
		} else if (colorType === 3 && palette) {
			const idx = recon[i] * 3;
			rgba[dst] = palette[idx] ?? 0;
			rgba[dst + 1] = palette[idx + 1] ?? 0;
			rgba[dst + 2] = palette[idx + 2] ?? 0;
			rgba[dst + 3] = 255;
		}
	}

	return { width, height, rgba };
}

const CRC32_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
		}
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) {
		c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	}
	return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const crcBuf = Buffer.alloc(4);
	crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // 8-bit
	ihdr[9] = 6; // RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 4);
		raw[rowStart] = 0; // filter none
		const srcStart = y * width * 4;
		raw.set(rgba.subarray(srcStart, srcStart + width * 4), rowStart + 1);
	}
	const compressed = zlib.deflateSync(raw);
	return Buffer.concat([
		sig,
		makePngChunk('IHDR', ihdr),
		makePngChunk('IDAT', compressed),
		makePngChunk('IEND', Buffer.alloc(0)),
	]);
}

// ============================================================================
// MAIN-PROCESS DESIGN ASSET SERVICE
// ============================================================================

async function fetchJsonWithTimeout(url: string, headers: Record<string, string> = {}): Promise<any> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

export class KodiaDesignAssetMainService extends Disposable implements IDesignAssetMainService {
	readonly _serviceBrand: undefined;

	private scanLocalWorkspaceAssets(workspaceRoot: string, query: string, limit: number): VisualAssetCandidate[] {
		if (!workspaceRoot || !fs.existsSync(workspaceRoot)) { return []; }
		const roots = ['public', 'assets', 'images', 'img', 'static', path.join('src', 'assets'), path.join('src', 'images')];
		const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
		const found: VisualAssetCandidate[] = [];
		const seen = new Set<string>();

		const walk = (dir: string, depth: number) => {
			if (depth > 4 || found.length >= limit * 3) { return; }
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') { continue; }
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full, depth + 1);
				} else if (/\.(png|jpe?g|webp|avif|svg|gif)$/i.test(entry.name)) {
					if (seen.has(full)) { continue; }
					seen.add(full);
					const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
					let dims: { width?: number; height?: number; format: string } = { format: path.extname(entry.name).slice(1) };
					try {
						const buf = fs.readFileSync(full);
						dims = inspectImageDimensions(buf, entry.name);
					} catch { /* ignore */ }
					found.push({
						id: `local-${rel}`,
						provider: 'local',
						title: entry.name,
						url: rel,
						width: dims.width,
						height: dims.height,
						aspectRatio: dims.width && dims.height ? `${dims.width}:${dims.height}` : undefined,
						mimeType: dims.format === 'svg' ? 'image/svg+xml' : `image/${dims.format}`,
						license: 'Project Local Asset',
						isLocal: true,
						localPath: full,
						altTextSuggestion: entry.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
						verified: true,
					});
				}
			}
		};

		for (const r of roots) {
			const full = path.join(workspaceRoot, r);
			if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
				walk(full, 0);
			}
		}

		// Rank local assets matching query words first
		found.sort((a, b) => {
			const sa = queryWords.filter(w => a.url.toLowerCase().includes(w)).length;
			const sb = queryWords.filter(w => b.url.toLowerCase().includes(w)).length;
			return sb - sa;
		});
		return found.slice(0, limit);
	}

	private async searchWikimedia(query: string, limit: number): Promise<VisualAssetCandidate[]> {
		const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&gsrlimit=${Math.min(12, limit * 2)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1200&format=json&origin=*`;
		const data = await fetchJsonWithTimeout(url);
		const pages = Object.values((data?.query?.pages ?? {}) as Record<string, any>);
		const results: VisualAssetCandidate[] = [];
		for (const page of pages) {
			const info = page?.imageinfo?.[0];
			if (!info?.url || !/^image\/(jpeg|png|webp)$/i.test(info.mime ?? '')) { continue; }
			const meta = info.extmetadata ?? {};
			const license = String(meta.LicenseShortName?.value ?? 'Wikimedia Commons License').replace(/<[^>]+>/g, '').trim();
			const author = String(meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 120);
			results.push({
				id: `wikimedia-${page.pageid}`,
				provider: 'wikimedia',
				title: String(page.title ?? '').replace(/^File:/i, ''),
				url: String(info.thumburl || info.url),
				thumbnailUrl: String(info.thumburl || info.url),
				width: Number(info.thumbwidth || info.width) || undefined,
				height: Number(info.thumbheight || info.height) || undefined,
				mimeType: info.mime,
				license,
				licenseUrl: meta.LicenseUrl?.value,
				author: author || undefined,
				attribution: author ? `${author} via Wikimedia Commons (${license})` : `Wikimedia Commons (${license})`,
				sourcePageUrl: info.descriptionurl,
				isLocal: false,
				altTextSuggestion: String(page.title ?? query).replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
				verified: true,
			});
			if (results.length >= limit) { break; }
		}
		return results;
	}

	private async searchOpenverse(query: string, orientation: string | undefined, limit: number): Promise<VisualAssetCandidate[]> {
		const aspectParam = orientation === 'landscape' ? '&aspect_ratio=wide' : orientation === 'portrait' ? '&aspect_ratio=tall' : orientation === 'square' ? '&aspect_ratio=square' : '';
		const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(12, limit)}${aspectParam}&mature=false`;
		const data = await fetchJsonWithTimeout(url);
		const items = Array.isArray(data?.results) ? data.results : [];
		return items.slice(0, limit).filter((it: any) => typeof it?.url === 'string' && it.url.startsWith('http')).map((it: any): VisualAssetCandidate => ({
			id: `openverse-${it.id}`,
			provider: 'openverse',
			title: String(it.title || query),
			url: String(it.url),
			thumbnailUrl: typeof it.thumbnail === 'string' ? it.thumbnail : undefined,
			width: typeof it.width === 'number' ? it.width : undefined,
			height: typeof it.height === 'number' ? it.height : undefined,
			license: `${String(it.license || 'cc').toUpperCase()} ${it.license_version || ''}`.trim(),
			licenseUrl: it.license_url,
			author: it.creator || undefined,
			attribution: it.attribution || `${it.creator || 'Creator'} via Openverse`,
			sourcePageUrl: it.foreign_landing_url,
			isLocal: false,
			altTextSuggestion: String(it.title || query),
			verified: true,
		}));
	}

	private async searchUnsplash(query: string, apiKey: string, orientation: string | undefined, limit: number): Promise<VisualAssetCandidate[]> {
		const orient = orientation === 'square' ? 'squarish' : orientation;
		const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${Math.min(12, limit)}${orient ? `&orientation=${orient}` : ''}`;
		const data = await fetchJsonWithTimeout(url, { Authorization: `Client-ID ${apiKey}` });
		const items = Array.isArray(data?.results) ? data.results : [];
		return items.slice(0, limit).map((it: any): VisualAssetCandidate => ({
			id: `unsplash-${it.id}`,
			provider: 'unsplash',
			title: String(it.alt_description || it.description || query),
			url: String(it.urls?.regular || it.urls?.full),
			thumbnailUrl: it.urls?.small,
			width: it.width,
			height: it.height,
			license: 'Unsplash License',
			licenseUrl: 'https://unsplash.com/license',
			author: it.user?.name,
			attribution: it.user?.name ? `Photo by ${it.user.name} on Unsplash` : 'Unsplash',
			sourcePageUrl: it.links?.html,
			isLocal: false,
			altTextSuggestion: String(it.alt_description || it.description || query),
			verified: true,
		}));
	}

	private async searchPexels(query: string, apiKey: string, orientation: string | undefined, limit: number): Promise<VisualAssetCandidate[]> {
		const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${Math.min(12, limit)}${orientation ? `&orientation=${orientation}` : ''}`;
		const data = await fetchJsonWithTimeout(url, { Authorization: apiKey });
		const items = Array.isArray(data?.photos) ? data.photos : [];
		return items.slice(0, limit).map((it: any): VisualAssetCandidate => ({
			id: `pexels-${it.id}`,
			provider: 'pexels',
			title: String(it.alt || query),
			url: String(it.src?.large2x || it.src?.large || it.src?.original),
			thumbnailUrl: it.src?.medium,
			width: it.width,
			height: it.height,
			license: 'Pexels License',
			licenseUrl: 'https://www.pexels.com/license/',
			author: it.photographer,
			attribution: it.photographer ? `Photo by ${it.photographer} on Pexels` : 'Pexels',
			sourcePageUrl: it.url,
			isLocal: false,
			altTextSuggestion: String(it.alt || query),
			verified: true,
		}));
	}

	private async searchPixabay(query: string, apiKey: string, orientation: string | undefined, limit: number): Promise<VisualAssetCandidate[]> {
		const orient = orientation === 'landscape' ? 'horizontal' : orientation === 'portrait' ? 'vertical' : 'all';
		const url = `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&image_type=photo&orientation=${orient}&safesearch=true&per_page=${Math.min(12, Math.max(3, limit))}`;
		const data = await fetchJsonWithTimeout(url);
		const items = Array.isArray(data?.hits) ? data.hits : [];
		return items.slice(0, limit).map((it: any): VisualAssetCandidate => ({
			id: `pixabay-${it.id}`,
			provider: 'pixabay',
			title: String(it.tags || query),
			url: String(it.largeImageURL || it.webformatURL),
			thumbnailUrl: it.previewURL,
			width: it.imageWidth,
			height: it.imageHeight,
			license: 'Pixabay Content License',
			licenseUrl: 'https://pixabay.com/service/license-summary/',
			author: it.user,
			attribution: it.user ? `Image by ${it.user} via Pixabay` : 'Pixabay',
			sourcePageUrl: it.pageURL,
			isLocal: false,
			altTextSuggestion: String(it.tags || query),
			verified: true,
		}));
	}

	async searchImageProviders(opts: {
		query: string;
		workspaceRoot?: string;
		providers?: readonly ImageProviderName[];
		apiKeys?: Partial<Record<'unsplash' | 'pexels' | 'pixabay', string>>;
		orientation?: 'landscape' | 'portrait' | 'square';
		limit?: number;
	}): Promise<VisualAssetSearchResult> {
		const limit = Math.max(1, Math.min(20, opts.limit ?? 6));
		const providers: readonly ImageProviderName[] = opts.providers && opts.providers.length > 0
			? opts.providers
			: ['local', 'openverse', 'wikimedia', 'unsplash', 'pexels', 'pixabay'];
		const assets: VisualAssetCandidate[] = [];
		const statuses: ProviderSearchStatus[] = [];

		for (const provider of providers) {
			if (provider === 'local') {
				const local = this.scanLocalWorkspaceAssets(opts.workspaceRoot ?? '', opts.query, limit);
				assets.push(...local);
				statuses.push({ provider: 'local', status: 'succeeded', count: local.length });
				continue;
			}
			if (provider === 'unsplash') {
				const key = opts.apiKeys?.unsplash || process.env.UNSPLASH_ACCESS_KEY;
				if (!key) {
					statuses.push({ provider: 'unsplash', status: 'skipped_no_key', count: 0, message: 'Configure Unsplash API key in Kodia Design Settings or UNSPLASH_ACCESS_KEY.' });
					continue;
				}
				try {
					const items = await this.searchUnsplash(opts.query, key, opts.orientation, limit);
					assets.push(...items);
					statuses.push({ provider: 'unsplash', status: 'succeeded', count: items.length });
				} catch (e) {
					statuses.push({ provider: 'unsplash', status: 'failed', count: 0, message: e instanceof Error ? e.message : String(e) });
				}
				continue;
			}
			if (provider === 'pexels') {
				const key = opts.apiKeys?.pexels || process.env.PEXELS_API_KEY;
				if (!key) {
					statuses.push({ provider: 'pexels', status: 'skipped_no_key', count: 0, message: 'Configure Pexels API key in Kodia Design Settings or PEXELS_API_KEY.' });
					continue;
				}
				try {
					const items = await this.searchPexels(opts.query, key, opts.orientation, limit);
					assets.push(...items);
					statuses.push({ provider: 'pexels', status: 'succeeded', count: items.length });
				} catch (e) {
					statuses.push({ provider: 'pexels', status: 'failed', count: 0, message: e instanceof Error ? e.message : String(e) });
				}
				continue;
			}
			if (provider === 'pixabay') {
				const key = opts.apiKeys?.pixabay || process.env.PIXABAY_API_KEY;
				if (!key) {
					statuses.push({ provider: 'pixabay', status: 'skipped_no_key', count: 0, message: 'Configure Pixabay API key in Kodia Design Settings or PIXABAY_API_KEY.' });
					continue;
				}
				try {
					const items = await this.searchPixabay(opts.query, key, opts.orientation, limit);
					assets.push(...items);
					statuses.push({ provider: 'pixabay', status: 'succeeded', count: items.length });
				} catch (e) {
					statuses.push({ provider: 'pixabay', status: 'failed', count: 0, message: e instanceof Error ? e.message : String(e) });
				}
				continue;
			}
			if (provider === 'openverse') {
				try {
					const items = await this.searchOpenverse(opts.query, opts.orientation, limit);
					assets.push(...items);
					statuses.push({ provider: 'openverse', status: 'succeeded', count: items.length });
				} catch (e) {
					statuses.push({ provider: 'openverse', status: 'failed', count: 0, message: e instanceof Error ? e.message : String(e) });
				}
				continue;
			}
			if (provider === 'wikimedia') {
				try {
					const items = await this.searchWikimedia(opts.query, limit);
					assets.push(...items);
					statuses.push({ provider: 'wikimedia', status: 'succeeded', count: items.length });
				} catch (e) {
					statuses.push({ provider: 'wikimedia', status: 'failed', count: 0, message: e instanceof Error ? e.message : String(e) });
				}
			}
		}

		return {
			query: opts.query,
			orientation: opts.orientation,
			assets: assets.slice(0, limit * 2),
			providerStatuses: statuses,
			fallbackRecommendation: assets.length === 0
				? 'No external assets returned (network offline or no provider match). Use download_visual_assets with generateSvgFallback to generate clean original SVG artwork in the workspace, or configure Unsplash/Pexels/Pixabay keys.'
				: undefined,
		};
	}

	async downloadVisualAssets(opts: {
		workspaceRoot: string;
		targetDir?: string;
		assets: readonly {
			url?: string;
			filename?: string;
			altText: string;
			provider?: ImageProviderName | 'generated-svg';
			license?: string;
			attribution?: string;
			generateSvgFallback?: {
				subject: string;
				primaryColor?: string;
				secondaryColor?: string;
				accentColor?: string;
				width?: number;
				height?: number;
				style?: 'abstract' | 'editorial' | 'product-backdrop' | 'mesh-gradient' | 'geometric';
			};
		}[];
	}): Promise<{ downloaded: DownloadedVisualAsset[]; attributionManifestPath?: string }> {
		const targetRel = opts.targetDir?.trim() || path.join('public', 'images');
		const destDir = path.isAbsolute(targetRel) ? path.resolve(targetRel) : path.resolve(opts.workspaceRoot, targetRel);
		if (!isInsideWorkspace(opts.workspaceRoot, destDir)) {
			throw new Error(`Target asset directory "${destDir}" is outside the workspace root.`);
		}
		fs.mkdirSync(destDir, { recursive: true });

		const downloaded: DownloadedVisualAsset[] = [];

		for (const item of opts.assets) {
			if (item.url && /^https?:\/\//i.test(item.url)) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
				try {
					const res = await fetch(item.url, {
						headers: { 'User-Agent': USER_AGENT },
						redirect: 'follow',
						signal: controller.signal,
					});
					if (!res.ok) {
						throw new Error(`HTTP ${res.status} downloading ${item.url}`);
					}
					const contentType = res.headers.get('content-type') || 'application/octet-stream';
					if (!contentType.toLowerCase().startsWith('image/')) {
						throw new Error(`Expected image/* content-type, received "${contentType}".`);
					}
					const arrBuf = await res.arrayBuffer();
					if (arrBuf.byteLength === 0) {
						throw new Error('Downloaded file was empty (0 bytes).');
					}
					if (arrBuf.byteLength > MAX_DOWNLOAD_BYTES) {
						throw new Error(`Downloaded image exceeded ${MAX_DOWNLOAD_BYTES} bytes limit.`);
					}
					const buf = Buffer.from(arrBuf);
					const ext = extFromMime(contentType);
					const fileName = sanitizeFilename(item.filename || item.altText || 'visual-asset', ext);
					const localPath = path.join(destDir, fileName);
					fs.writeFileSync(localPath, buf);
					const dims = inspectImageDimensions(buf, contentType);
					downloaded.push({
						sourceUrl: item.url,
						localPath,
						relativePath: path.relative(opts.workspaceRoot, localPath).replace(/\\/g, '/'),
						provider: item.provider ?? 'openverse',
						mimeType: contentType.split(';')[0].trim(),
						sizeBytes: buf.byteLength,
						width: dims.width,
						height: dims.height,
						license: item.license || 'Verified External Source',
						attribution: item.attribution,
						altText: item.altText,
						verifiedOnDisk: fs.existsSync(localPath) && fs.statSync(localPath).size === buf.byteLength,
					});
					continue;
				} catch (e) {
					if (!item.generateSvgFallback) {
						downloaded.push({
							sourceUrl: item.url,
							localPath: '',
							relativePath: '',
							provider: item.provider ?? 'openverse',
							mimeType: '',
							sizeBytes: 0,
							license: item.license || 'unknown',
							altText: item.altText,
							verifiedOnDisk: false,
							error: e instanceof Error ? e.message : String(e),
						});
						continue;
					}
				} finally {
					clearTimeout(timer);
				}
			}

			if (item.generateSvgFallback) {
				const svg = generateBespokeSvgArtwork(item.generateSvgFallback);
				const buf = Buffer.from(svg, 'utf8');
				const fileName = sanitizeFilename(item.filename || item.generateSvgFallback.subject || 'artwork', '.svg').replace(/\.[^.]+$/, '.svg');
				const localPath = path.join(destDir, fileName);
				fs.writeFileSync(localPath, buf);
				const dims = inspectImageDimensions(buf, 'image/svg+xml');
				downloaded.push({
					sourceUrl: 'generated://kodia-bespoke-svg',
					localPath,
					relativePath: path.relative(opts.workspaceRoot, localPath).replace(/\\/g, '/'),
					provider: 'generated-svg',
					mimeType: 'image/svg+xml',
					sizeBytes: buf.byteLength,
					width: dims.width,
					height: dims.height,
					license: 'Original Generated SVG (Project Owned)',
					altText: item.altText,
					verifiedOnDisk: fs.existsSync(localPath) && fs.statSync(localPath).size === buf.byteLength,
				});
			}
		}

		// Write or merge attribution manifest for verified downloaded assets
		const verified = downloaded.filter(d => d.verifiedOnDisk);
		let attributionManifestPath: string | undefined;
		if (verified.length > 0) {
			attributionManifestPath = path.join(destDir, 'ASSETS_ATTRIBUTION.json');
			let existing: any[] = [];
			if (fs.existsSync(attributionManifestPath)) {
				try {
					const parsed = JSON.parse(fs.readFileSync(attributionManifestPath, 'utf8'));
					if (Array.isArray(parsed)) { existing = parsed; }
				} catch { /* overwrite corrupt manifest */ }
			}
			const byPath = new Map<string, any>();
			for (const entry of existing) {
				if (entry?.relativePath) { byPath.set(entry.relativePath, entry); }
			}
			for (const d of verified) {
				byPath.set(d.relativePath, {
					relativePath: d.relativePath,
					provider: d.provider,
					sourceUrl: d.sourceUrl,
					license: d.license,
					attribution: d.attribution,
					altText: d.altText,
					width: d.width,
					height: d.height,
					sizeBytes: d.sizeBytes,
					downloadedAt: new Date().toISOString(),
				});
			}
			fs.writeFileSync(attributionManifestPath, JSON.stringify([...byPath.values()], null, 2), 'utf8');
		}

		return { downloaded, attributionManifestPath };
	}

	async optimizeVisualAssets(opts: {
		workspaceRoot: string;
		targetPaths?: readonly string[];
		minifySvgs?: boolean;
	}): Promise<AssetOptimizationReport> {
		const minifySvgs = opts.minifySvgs ?? true;
		const filesToCheck: string[] = [];

		if (opts.targetPaths && opts.targetPaths.length > 0) {
			for (const p of opts.targetPaths) {
				const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(opts.workspaceRoot, p);
				if (!isInsideWorkspace(opts.workspaceRoot, resolved)) { continue; }
				if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
					for (const entry of fs.readdirSync(resolved)) {
						const full = path.join(resolved, entry);
						if (fs.statSync(full).isFile() && /\.(png|jpe?g|webp|avif|svg|gif)$/i.test(entry)) {
							filesToCheck.push(full);
						}
					}
				} else {
					filesToCheck.push(resolved);
				}
			}
		} else {
			for (const local of this.scanLocalWorkspaceAssets(opts.workspaceRoot, '', 40)) {
				if (local.localPath) { filesToCheck.push(local.localPath); }
			}
		}

		const entries: AssetOptimizationEntry[] = [];
		const warnings: string[] = [];
		let optimizedCount = 0;
		let totalSavedBytes = 0;

		for (const filePath of filesToCheck) {
			if (!fs.existsSync(filePath)) {
				entries.push({
					filePath: path.relative(opts.workspaceRoot, filePath).replace(/\\/g, '/'),
					originalBytes: 0,
					optimizedBytes: 0,
					savedBytes: 0,
					format: 'missing',
					action: 'missing-or-unreadable',
					recommendation: 'File does not exist on disk.',
				});
				warnings.push(`Missing visual asset: ${filePath}`);
				continue;
			}

			const buf = fs.readFileSync(filePath);
			const origBytes = buf.byteLength;
			const rel = path.relative(opts.workspaceRoot, filePath).replace(/\\/g, '/');
			const dims = inspectImageDimensions(buf, path.extname(filePath));

			if (dims.format === 'svg' && minifySvgs) {
				const rawSvg = buf.toString('utf8');
				const minified = rawSvg
					.replace(/<!--[\s\S]*?-->/g, '')
					.replace(/<\?xml[\s\S]*?\?>/gi, '')
					.replace(/\s{2,}/g, ' ')
					.replace(/>\s+</g, '><')
					.trim();
				const newBuf = Buffer.from(minified, 'utf8');
				if (newBuf.byteLength < origBytes) {
					fs.writeFileSync(filePath, newBuf);
					const saved = origBytes - newBuf.byteLength;
					totalSavedBytes += saved;
					optimizedCount++;
					entries.push({
						filePath: rel,
						originalBytes: origBytes,
						optimizedBytes: newBuf.byteLength,
						savedBytes: saved,
						format: 'svg',
						width: dims.width,
						height: dims.height,
						action: 'minified-svg',
						responsiveMarkupHint: `<img src="/${rel.replace(/^public\//, '')}" ${dims.width ? `width="${dims.width}" ` : ''}${dims.height ? `height="${dims.height}" ` : ''}alt="..." loading="lazy" />`,
					});
					continue;
				}
			}

			const isOversized = origBytes > 350_000 || (dims.width ?? 0) > 2400;
			if (isOversized) {
				warnings.push(`${rel} is ${(origBytes / 1024).toFixed(0)} KB${dims.width ? ` (${dims.width}x${dims.height})` : ''} — consider converting to WebP/AVIF or resizing to <=1600px wide.`);
			}

			entries.push({
				filePath: rel,
				originalBytes: origBytes,
				optimizedBytes: origBytes,
				savedBytes: 0,
				format: dims.format,
				width: dims.width,
				height: dims.height,
				action: isOversized ? 'needs-resize-warning' : 'verified-optimal',
				recommendation: isOversized ? 'Convert to WebP/AVIF and serve responsive widths (640w, 1280w, 1920w).' : undefined,
				responsiveMarkupHint: `<img src="/${rel.replace(/^public\//, '')}" ${dims.width ? `width="${dims.width}" ` : ''}${dims.height ? `height="${dims.height}" ` : ''}alt="..." loading="lazy" decoding="async" />`,
			});
		}

		return {
			scannedCount: entries.length,
			optimizedCount,
			totalSavedBytes,
			warnings,
			entries,
		};
	}

	async compareVisualRevisions(opts: {
		baselinePath: string;
		currentPath: string;
		diffOutputPath?: string;
		pixelThreshold?: number;
	}): Promise<VisualRevisionComparison> {
		const threshold = Math.max(0, Math.min(255, opts.pixelThreshold ?? 18));
		try {
			if (!fs.existsSync(opts.baselinePath)) {
				throw new Error(`Baseline screenshot not found: ${opts.baselinePath}`);
			}
			if (!fs.existsSync(opts.currentPath)) {
				throw new Error(`Current screenshot not found: ${opts.currentPath}`);
			}
			const basePng = decodePngToRgba(fs.readFileSync(opts.baselinePath));
			const currPng = decodePngToRgba(fs.readFileSync(opts.currentPath));
			const dimensionsMatch = basePng.width === currPng.width && basePng.height === currPng.height;
			const compareW = Math.min(basePng.width, currPng.width);
			const compareH = Math.min(basePng.height, currPng.height);
			const totalPixels = compareW * compareH;
			let changedPixels = 0;
			let minX = compareW, minY = compareH, maxX = -1, maxY = -1;
			const diffRgba = new Uint8Array(compareW * compareH * 4);

			for (let y = 0; y < compareH; y++) {
				for (let x = 0; x < compareW; x++) {
					const bi = (y * basePng.width + x) * 4;
					const ci = (y * currPng.width + x) * 4;
					const di = (y * compareW + x) * 4;
					const dr = Math.abs(basePng.rgba[bi] - currPng.rgba[ci]);
					const dg = Math.abs(basePng.rgba[bi + 1] - currPng.rgba[ci + 1]);
					const db = Math.abs(basePng.rgba[bi + 2] - currPng.rgba[ci + 2]);
					const da = Math.abs(basePng.rgba[bi + 3] - currPng.rgba[ci + 3]);
					const delta = Math.max(dr, dg, db, da);
					if (delta > threshold) {
						changedPixels++;
						if (x < minX) { minX = x; }
						if (y < minY) { minY = y; }
						if (x > maxX) { maxX = x; }
						if (y > maxY) { maxY = y; }
						// Highlight changed pixel in vivid magenta
						diffRgba[di] = 244;
						diffRgba[di + 1] = 63;
						diffRgba[di + 2] = 94;
						diffRgba[di + 3] = 255;
					} else {
						// Dim unchanged pixel
						diffRgba[di] = Math.round(currPng.rgba[ci] * 0.35);
						diffRgba[di + 1] = Math.round(currPng.rgba[ci + 1] * 0.35);
						diffRgba[di + 2] = Math.round(currPng.rgba[ci + 2] * 0.35);
						diffRgba[di + 3] = 255;
					}
				}
			}

			const diffPercentage = totalPixels > 0 ? Math.round((changedPixels / totalPixels) * 10_000) / 100 : 0;
			let diffImagePath: string | undefined;
			if (changedPixels > 0) {
				const outPath = opts.diffOutputPath || path.join(path.dirname(opts.currentPath), `diff-${Date.now().toString(36)}.png`);
				fs.mkdirSync(path.dirname(outPath), { recursive: true });
				fs.writeFileSync(outPath, encodeRgbaToPng(compareW, compareH, diffRgba));
				diffImagePath = outPath;
			}

			const changedRegion = changedPixels > 0 && maxX >= minX && maxY >= minY
				? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
				: undefined;

			const verdict: VisualRevisionComparison['verdict'] = !dimensionsMatch
				? 'dimension-mismatch'
				: changedPixels === 0 ? 'identical'
					: diffPercentage < 2 ? 'minor-change'
						: diffPercentage < 15 ? 'moderate-change'
							: 'major-change';

			return {
				baselinePath: opts.baselinePath,
				currentPath: opts.currentPath,
				diffImagePath,
				baselineSize: { width: basePng.width, height: basePng.height },
				currentSize: { width: currPng.width, height: currPng.height },
				dimensionsMatch,
				totalPixelsCompared: totalPixels,
				changedPixels,
				diffPercentage,
				changedRegion,
				verdict,
				summary: `Visual comparison [${verdict}]: ${changedPixels.toLocaleString()} / ${totalPixels.toLocaleString()} pixels changed (${diffPercentage}%)${!dimensionsMatch ? ` (dimensions changed: ${basePng.width}x${basePng.height} -> ${currPng.width}x${currPng.height})` : ''}${diffImagePath ? `. Diff highlight PNG saved to ${diffImagePath}` : ''}.`,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				baselinePath: opts.baselinePath,
				currentPath: opts.currentPath,
				baselineSize: { width: 0, height: 0 },
				currentSize: { width: 0, height: 0 },
				dimensionsMatch: false,
				totalPixelsCompared: 0,
				changedPixels: 0,
				diffPercentage: 0,
				verdict: 'error',
				summary: `Visual comparison error: ${msg}`,
				error: msg,
			};
		}
	}
}
