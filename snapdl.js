// ==UserScript==
// @name         Snapchat Image & Video Downloader (HD)
// @name:fr      Snapchat Téléchargeur d'images et de vidéos (HD)
// @namespace    https://github.com/Molotovah
// @version      3.12.0
// @description  Download Snapchat images and videos in full resolution. Auto-detects split video segments and merges them into one file.
// @description:fr Téléchargez images et vidéos Snapchat en pleine résolution. Détecte et fusionne automatiquement les vidéos découpées en plusieurs snaps.
// @author       Molotovah (https://github.com/Molotovah)
// @match        *://*.snapchat.com/*
// @grant        none
// @run-at       document-start
// @license      MIT
// @icon         https://www.google.com/s2/favicons?domain=snapchat.com&sz=64
// @homepageURL  https://github.com/Molotovah
// ==/UserScript==

(function () {
    'use strict';

    // ── Blob interception ─────────────────────────────────────────────────────
    // Runs at document-start, before Snapchat JS.
    // Chain: fetch(CDN) → Response.blob() → Blob → createObjectURL → blob:url
    // We tag each Blob via WeakMap so date + sourceUrl can be resolved later.

    const blobMeta = new WeakMap(); // Blob → { date?, sourceUrl? }
    const blobUrlMeta = new Map(); // "blob:…" → { date?, sourceUrl? }

    const parseDateFromCdnUrl = (urlStr) => {
        try {
            const params = new URL(urlStr).searchParams;
            for (const key of ['t', 'ts', 'timestamp', 'ct']) {
                const val = params.get(key);
                if (!val) continue;
                const n = parseInt(val, 10);
                if (isNaN(n)) continue;
                const d = new Date(n > 1e10 ? n : n * 1000);
                if (!isNaN(d.getTime())) return d;
            }
        } catch (_) {}
        return null;
    };

    const origResponseBlob = Response.prototype.blob;
    Response.prototype.blob = async function () {
        const blob = await origResponseBlob.call(this);
        const urlDate = parseDateFromCdnUrl(this.url);
        const headerDate = this.headers.get('Last-Modified') || this.headers.get('Date');
        const date = urlDate || (headerDate ? new Date(headerDate) : null);
        const contentType = (this.headers.get('Content-Type') || blob.type || '').split(';')[0].trim();
        const meta = {};
        if (date && !isNaN(date.getTime())) meta.date = date;
        if (this.url) meta.sourceUrl = this.url;
        if (contentType) meta.contentType = contentType;
        if (meta.date || meta.sourceUrl || meta.contentType) blobMeta.set(blob, meta);
        return blob;
    };

    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (source) {
        const url = origCreateObjectURL(source);
        if (blobMeta.has(source)) blobUrlMeta.set(url, blobMeta.get(source));
        return url;
    };

    const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function (url) {
        blobUrlMeta.delete(url);
        origRevokeObjectURL(url);
    };

    // ── Segment collection ────────────────────────────────────────────────────
    // Snapchat uses opaque CDN URLs — collect all video blobs in DOM order.
    // The floating panel lets the user merge them explicitly after scrolling
    // through all segments to load them.

    const collectVideoBlobsInDomOrder = () => {
        const result = [];
        document.querySelectorAll('video').forEach(el => {
            const src = el.currentSrc || el.src;
            if (src && src.startsWith('blob:')) {
                result.push({ blobUrl: src, el, meta: blobUrlMeta.get(src) });
            }
        });
        return result;
    };

    // ── Binary helpers (Firefox Xray-safe: no TypedArray) ────────────────────
    // Read: FileReader → atob → charCodeAt.  Write: btoa → fetch(data:) → Blob.

    const readBlobBinary = (blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => { try { resolve(atob(fr.result.split(',')[1])); } catch (e) { reject(e); } };
        fr.onerror = () => reject(new Error('FileReader error'));
        fr.readAsDataURL(blob);
    });

    const binaryToBlob = (binary, type) =>
        fetch(`data:${type};base64,${btoa(binary)}`).then(r => r.blob());

    // EBML VINT parser (variable-length integer used in WebM element sizes)
    const readVint = (binary, pos) => {
        const b = binary.charCodeAt(pos);
        if (b & 0x80) return { value: b & 0x7F, len: 1 };
        if (b & 0x40) return { value: ((b & 0x3F) << 8) | binary.charCodeAt(pos + 1), len: 2 };
        if (b & 0x20) return { value: ((b & 0x1F) << 16) | (binary.charCodeAt(pos + 1) << 8) | binary.charCodeAt(pos + 2), len: 3 };
        if (b & 0x10) return { value: ((b & 0x0F) * 0x1000000) + (binary.charCodeAt(pos + 1) << 16) + (binary.charCodeAt(pos + 2) << 8) + binary.charCodeAt(pos + 3), len: 4 };
        return { value: 0, len: 1 };
    };

    // ── WebM Duration field parser (pure binary string, no TypedArray/DataView) ─
    // EBML Duration (ID 0x44 0x89) stores the value as float32 (4 bytes) or
    // float64 (8 bytes). We decode IEEE 754 via charCodeAt — no TypedArray,
    // no DataView, no Xray restriction.

    const readFloat64BE = (binary, pos) => {
        const b0 = binary.charCodeAt(pos),     b1 = binary.charCodeAt(pos + 1),
              b2 = binary.charCodeAt(pos + 2), b3 = binary.charCodeAt(pos + 3),
              b4 = binary.charCodeAt(pos + 4), b5 = binary.charCodeAt(pos + 5),
              b6 = binary.charCodeAt(pos + 6), b7 = binary.charCodeAt(pos + 7);
        const sign = b0 >> 7 ? -1 : 1;
        const exp  = ((b0 & 0x7F) << 4) | (b1 >> 4);
        const mHi  = (b1 & 0xF) * 65536 + b2 * 256 + b3;                    // 20 bits
        const mLo  = b4 * 16777216 + b5 * 65536 + b6 * 256 + b7;             // 32 bits
        const mant = (mHi * 4294967296 + mLo) / 4503599627370496;            // / 2^52
        if (exp === 2047) return (mHi || mLo) ? NaN : sign * Infinity;
        if (exp === 0)    return sign * mant * Math.pow(2, -1022);
        return sign * (1 + mant) * Math.pow(2, exp - 1023);
    };

    const readFloat32BE = (binary, pos) => {
        const b0 = binary.charCodeAt(pos),   b1 = binary.charCodeAt(pos + 1),
              b2 = binary.charCodeAt(pos + 2), b3 = binary.charCodeAt(pos + 3);
        const sign = b0 >> 7 ? -1 : 1;
        const exp  = ((b0 & 0x7F) << 1) | (b1 >> 7);
        const mant = ((b1 & 0x7F) * 65536 + b2 * 256 + b3) / 8388608;       // / 2^23
        if (exp === 255) return (b1 & 0x7F || b2 || b3) ? NaN : sign * Infinity;
        if (exp === 0)   return sign * mant * Math.pow(2, -126);
        return sign * (1 + mant) * Math.pow(2, exp - 127);
    };

    const getWebMDurationMs = async (blob) => {
        const binary = await readBlobBinary(blob.slice(0, 65536));
        for (let i = 0; i < binary.length - 11; i++) {
            if (binary.charCodeAt(i) !== 0x44 || binary.charCodeAt(i + 1) !== 0x89) continue;
            const sz = binary.charCodeAt(i + 2);
            if (sz === 0x88) { const d = readFloat64BE(binary, i + 3); if (isFinite(d) && d > 0) { console.log('[SnapDL] Duration (f64):', d, 'ms'); return Math.round(d); } }
            if (sz === 0x84) { const d = readFloat32BE(binary, i + 3); if (isFinite(d) && d > 0) { console.log('[SnapDL] Duration (f32):', d, 'ms'); return Math.round(d); } }
        }
        console.warn('[SnapDL] Duration not found in WebM header');
        return 0;
    };

    // ── Fix first blob: Segment element size → UNKNOWN ────────────────────────
    // If the Segment EBML element has a fixed size, WebM parsers stop reading
    // exactly at that byte offset and ignore all appended clusters.
    // Setting size to UNKNOWN (0x01 FF FF FF FF FF FF FF) lets parsers continue
    // to EOF, which is required for concatenation to work.

    const ensureUnknownSegmentSize = async (blob) => {
        // Only read first 128 bytes — Segment ID always appears within first 64 bytes
        const hdr = await readBlobBinary(blob.slice(0, 128));
        for (let i = 0; i < hdr.length - 12; i++) {
            if (hdr.charCodeAt(i)     !== 0x18 || hdr.charCodeAt(i + 1) !== 0x53 ||
                hdr.charCodeAt(i + 2) !== 0x80 || hdr.charCodeAt(i + 3) !== 0x67) continue;
            const p = i + 4;
            if (hdr.charCodeAt(p) !== 0x01) return blob; // not 8-byte VINT, skip
            let already = true;
            for (let k = 1; k < 8; k++) if (hdr.charCodeAt(p + k) !== 0xFF) { already = false; break; }
            if (already) return blob;
            const patchedHdr = hdr.slice(0, p) + '\x01\xFF\xFF\xFF\xFF\xFF\xFF\xFF' + hdr.slice(p + 8);
            console.log('[SnapDL] Patched Segment size to UNKNOWN at byte', p);
            // Reconstruct: patched 128-byte header + rest of original blob unchanged
            return new Blob([await binaryToBlob(patchedHdr, blob.type), blob.slice(128)], { type: blob.type });
        }
        return blob;
    };

    // ── Append-segment preparation (strip header + patch Cluster Timecodes) ──
    // Strips the EBML/Segment/Tracks header so only Clusters remain.
    // Patches each Cluster's Timecode child by adding `offsetMs` so timestamps
    // are monotonically increasing across the concatenated file.

    const prepareAppendSegment = async (blob, offsetMs) => {
        if (!(blob.type || '').includes('webm')) return blob;
        const binary = await readBlobBinary(blob);

        // Find first Cluster (0x1F 0x43 0xB6 0x75) within first 128 KB
        let clusterStart = -1;
        const scanEnd = Math.min(binary.length - 4, 131072);
        for (let i = 0; i < scanEnd; i++) {
            if (binary.charCodeAt(i) === 0x1F && binary.charCodeAt(i + 1) === 0x43 &&
                binary.charCodeAt(i + 2) === 0xB6 && binary.charCodeAt(i + 3) === 0x75) {
                clusterStart = i; break;
            }
        }
        const sliceFrom = clusterStart >= 0 ? clusterStart : 0;
        console.log('[SnapDL] Segment cluster start:', sliceFrom, 'offset:', offsetMs, 'ms');

        if (offsetMs <= 0) return binaryToBlob(binary.slice(sliceFrom), blob.type);

        const parts = [];
        let lastCopy = sliceFrom;
        let pos = sliceFrom;

        while (pos < binary.length - 7) {
            if (binary.charCodeAt(pos)     !== 0x1F || binary.charCodeAt(pos + 1) !== 0x43 ||
                binary.charCodeAt(pos + 2) !== 0xB6 || binary.charCodeAt(pos + 3) !== 0x75) { pos++; continue; }

            let p = pos + 4;
            p += readVint(binary, p).len; // skip Cluster size

            if (p >= binary.length || binary.charCodeAt(p) !== 0xE7) { pos++; continue; }
            p += 1;

            const tcv = readVint(binary, p);
            p += tcv.len;
            const tcSize = tcv.value;
            if (tcSize < 1 || tcSize > 6) { pos++; continue; }

            let origTime = 0;
            for (let j = 0; j < tcSize; j++) origTime = origTime * 256 + binary.charCodeAt(p + j);
            const newTime = origTime + offsetMs;
            let patch = '';
            for (let j = tcSize - 1; j >= 0; j--) patch = String.fromCharCode((newTime >>> (j * 8)) & 0xFF) + patch;

            parts.push(binary.slice(lastCopy, p));
            parts.push(patch);
            lastCopy = p + tcSize;
            pos = p + tcSize;
        }
        parts.push(binary.slice(lastCopy));
        return binaryToBlob(parts.join(''), blob.type);
    };

    // ── Merge orchestrator ────────────────────────────────────────────────────

    const mergeVideoSegments = async (blobUrls, onProgress) => {
        // Step 1: fetch all segment blobs
        const blobs = [];
        for (let i = 0; i < blobUrls.length; i++) {
            onProgress && onProgress({ phase: 'record', done: i + 1, total: blobUrls.length });
            const resp = await fetch(blobUrls[i]);
            const blob = await resp.blob();
            console.log('[SnapDL] Fetched segment', i + 1, 'type:', blob.type, 'size:', blob.size);
            blobs.push(blob);
        }
        if (blobs.length === 1) return blobs[0];

        onProgress && onProgress({ phase: 'concat', done: blobs.length, total: blobs.length });

        const outType = blobs[0].type || 'video/webm';
        if (!outType.includes('webm')) {
            console.warn('[SnapDL] Non-WebM format:', outType, '— raw concat may not work');
            return new Blob(blobs, { type: outType });
        }

        // Step 2: patch Segment size in first blob to UNKNOWN so parsers read past it
        const firstBlob = await ensureUnknownSegmentSize(blobs[0]);

        // Step 3: cumulative duration offsets for Cluster Timecode patching
        let cumMs = 0;
        const offsets = [0];
        for (let i = 0; i < blobs.length - 1; i++) {
            const dur = await getWebMDurationMs(blobs[i]);
            console.log('[SnapDL] Segment', i + 1, 'duration:', dur, 'ms');
            cumMs += dur;
            offsets.push(cumMs);
        }

        // Step 4: strip headers + patch timestamps in segments 2..N
        const parts = [firstBlob];
        for (let i = 1; i < blobs.length; i++) {
            parts.push(await prepareAppendSegment(blobs[i], offsets[i]));
        }

        return new Blob(parts, { type: outType });
    };

    // ── i18n ─────────────────────────────────────────────────────────────────

    const translations = {
        en: { btn: 'Download', merge: 'Merge', toast: 'Downloading', rec: 'Loading', concat: 'Merging…' },
        tr: { btn: 'İndir', merge: 'Birleştir', toast: 'İndiriliyor', rec: 'Yükleniyor', concat: 'Birleştiriliyor…' },
        es: { btn: 'Descargar', merge: 'Combinar', toast: 'Descargando', rec: 'Cargando', concat: 'Combinando…' },
        fr: { btn: 'Télécharger', merge: 'Fusionner', toast: 'Téléchargement', rec: 'Chargement', concat: 'Fusion…' },
        de: { btn: 'Herunterladen', merge: 'Zusammenführen', toast: 'Wird heruntergeladen', rec: 'Laden', concat: 'Zusammenführen…' },
        pt: { btn: 'Baixar', merge: 'Mesclar', toast: 'Baixando', rec: 'Carregando', concat: 'Mesclando…' },
        ru: { btn: 'Скачать', merge: 'Объединить', toast: 'Скачивание', rec: 'Загрузка', concat: 'Объединение…' },
        zh: { btn: '下载', merge: '合并', toast: '下载中', rec: '加载中', concat: '合并中…' },
        hi: { btn: 'डाउनलोड', merge: 'मर्ज', toast: 'डाउनलोड हो रहा है', rec: 'लोड', concat: 'मर्ज हो रहा है…' },
        ar: { btn: 'تنزيل', merge: 'دمج', toast: 'جارٍ التنزيل', rec: 'جارٍ التحميل', concat: 'جارٍ الدمج…' },
        ja: { btn: 'ダウンロード', merge: '結合', toast: 'ダウンロード中', rec: '読み込み中', concat: '結合中…' },
        ko: { btn: '다운로드', merge: '병합', toast: '다운로드 중', rec: '불러오는 중', concat: '병합 중…' },
        bn: { btn: 'ডাউনলোড', merge: 'মার্জ', toast: 'ডাউনলোড হচ্ছে', rec: 'লোড', concat: 'মার্জ হচ্ছে…' },
        it: { btn: 'Scarica', merge: 'Unisci', toast: 'Scaricamento', rec: 'Caricamento', concat: 'Unione…' },
        id: { btn: 'Unduh', merge: 'Gabungkan', toast: 'Mengunduh', rec: 'Memuat', concat: 'Menggabungkan…' }
    };

    const getLang = () => {
        const key = navigator.language.split('-')[0];
        return translations[key] || translations.en;
    };

    // ── Styles ────────────────────────────────────────────────────────────────

    const injectStyles = () => {
        const style = document.createElement('style');
        style.textContent = `
            .snap-dl-btn {
                position: absolute;
                bottom: 12px;
                right: 12px;
                z-index: 2147483647;
                background: rgba(0, 0, 0, 0.75);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.35);
                border-radius: 6px;
                padding: 5px 10px;
                font-size: 12px;
                font-weight: bold;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                backdrop-filter: blur(5px);
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                gap: 5px;
            }
            .snap-dl-btn:hover:not(:disabled) {
                background: rgba(0, 0, 0, 0.92);
                transform: scale(1.05);
                border-color: #fffc00;
            }
            .snap-dl-btn:disabled { opacity: 0.65; cursor: default; }
            .snap-container-relative { position: relative !important; }
            .snap-dl-merge-panel {
                position: fixed;
                bottom: 70px;
                right: 20px;
                z-index: 2147483647;
                background: rgba(10, 10, 10, 0.88);
                color: #fffc00;
                border: 1px solid rgba(255, 252, 0, 0.6);
                border-radius: 8px;
                padding: 8px 14px;
                font-size: 13px;
                font-weight: bold;
                cursor: pointer;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                backdrop-filter: blur(8px);
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .snap-dl-merge-panel:hover:not(:disabled) { background: rgba(30, 30, 10, 0.96); transform: scale(1.04); }
            .snap-dl-merge-panel:disabled { opacity: 0.65; cursor: default; }
            .snap-dl-toast {
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%) translateY(0);
                z-index: 2147483647;
                background: rgba(20, 20, 20, 0.92);
                color: #fff;
                border: 1px solid rgba(255, 252, 0, 0.5);
                border-radius: 8px;
                padding: 10px 18px;
                font-size: 13px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                backdrop-filter: blur(8px);
                pointer-events: none;
                opacity: 1;
                transition: opacity 0.4s ease, transform 0.4s ease;
                max-width: 90vw;
                text-align: center;
                word-break: break-all;
            }
            .snap-dl-toast.snap-dl-toast--out {
                opacity: 0;
                transform: translateX(-50%) translateY(12px);
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    };

    // ── Toast ─────────────────────────────────────────────────────────────────

    const showToast = (message, dateIsOriginal) => {
        const el = document.createElement('div');
        el.className = 'snap-dl-toast';
        el.textContent = `⬇ ${message}${dateIsOriginal ? '' : ' ⚠ date approx.'}`;
        document.body.appendChild(el);
        setTimeout(() => {
            el.classList.add('snap-dl-toast--out');
            el.addEventListener('transitionend', () => el.remove(), { once: true });
        }, 2800);
    };

    // ── Filename helpers ──────────────────────────────────────────────────────

    const formatDate = (date) => {
        const p = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
    };

    const sanitizeFilenameSegment = (str) =>
        str.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').slice(0, 50);

    const getConversationName = () => {
        const titleMatch = document.title.match(/^(.+?)\s*[-|]\s*Snapchat\s*$/i);
        if (titleMatch) {
            const name = titleMatch[1].trim();
            if (name.toLowerCase() !== 'snapchat') return name;
        }
        const heading = document.querySelector('h1, h2, [role="heading"]');
        return (heading && heading.textContent.trim()) || null;
    };

    const buildFilename = (type, ext, meta, suffix) => {
        const convName = getConversationName();
        const convPart = convName ? `${sanitizeFilenameSegment(convName)}_` : '';
        const sfx = suffix ? `_${suffix}` : '';
        return `snapchat_${convPart}${type}${sfx}_${formatDate((meta && meta.date) || new Date())}.${ext}`;
    };

    // ── Content-type → file type/extension mapping ────────────────────────────

    const CONTENT_TYPE_MAP = {
        'video/mp4': ['video', 'mp4'],
        'video/webm': ['video', 'webm'],
        'video/quicktime': ['video', 'mov'],
        'video/x-matroska': ['video', 'mkv'],
        'image/webp': ['image', 'webp'],
        'image/jpeg': ['image', 'jpg'],
        'image/png': ['image', 'png'],
        'image/gif': ['image', 'gif'],
        'image/avif': ['image', 'avif'],
    };

    const resolveFileType = (meta, el) => {
        const ct = meta && meta.contentType;
        if (ct && CONTENT_TYPE_MAP[ct]) return CONTENT_TYPE_MAP[ct];
        return el instanceof HTMLVideoElement ? ['video', 'mp4'] : ['image', 'png'];
    };

    // ── Download trigger ──────────────────────────────────────────────────────
    // a.click() is required to trigger <a download> activation behavior in Firefox.
    // dispatchEvent(new MouseEvent) does NOT reliably trigger downloads.
    // A capture-phase handler on document stops the click from reaching Snapchat's
    // SPA router (React bubble-phase listener on document) before it can navigate.

    const triggerDownload = (url, filename) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        const blockSpa = e => { e.stopPropagation(); e.stopImmediatePropagation(); };
        document.addEventListener('click', blockSpa, { capture: true, once: true });
        a.click();
        document.removeEventListener('click', blockSpa, { capture: true });
        document.body.removeChild(a);
    };

    // ── Single media download ─────────────────────────────────────────────────
    // Detects real Content-Type from blob URL headers so WebM video isn't saved
    // as .mp4 (wrong extension → decoder mismatch → audio only, black video).

    const downloadMedia = async (el) => {
        const src = el.currentSrc || el.src;
        if (!src || !src.startsWith('blob:')) return;

        const meta = blobUrlMeta.get(src) || {};
        let contentType = meta.contentType;

        if (!contentType) {
            try {
                const resp = await fetch(src);
                contentType = (resp.headers.get('Content-Type') || '').split(';')[0].trim();
                if (resp.body) resp.body.cancel().catch(() => {});
                console.log('[SnapDL] Detected content-type:', contentType);
            } catch (e) {
                console.warn('[SnapDL] Content-type detection failed:', e.message);
            }
        }

        const [fileType, ext] = resolveFileType({ contentType }, el);
        const filename = buildFilename(fileType, ext, meta);
        console.log('[SnapDL] Downloading:', filename, '(type:', contentType || 'unknown', ')');
        triggerDownload(src, filename);
        showToast(filename, !!(meta && meta.date));
    };

    // ── Floating merge panel ──────────────────────────────────────────────────
    // Appears fixed bottom-right whenever 2+ video blobs are in the DOM.
    // User scrolls through split snaps to load them all, then clicks Merge.

    let _mergePanel = null;
    let _mergeInProgress = false;

    const updateMergePanel = () => {
        if (_mergeInProgress) return;
        const segments = collectVideoBlobsInDomOrder();
        const { merge: mergeText } = getLang();

        if (segments.length < 2) {
            if (_mergePanel) { _mergePanel.remove(); _mergePanel = null; }
            return;
        }

        if (!_mergePanel) {
            _mergePanel = document.createElement('button');
            _mergePanel.className = 'snap-dl-merge-panel';
            document.body.appendChild(_mergePanel);

            _mergePanel.onclick = async () => {
                const btn = _mergePanel;
                btn.disabled = true;
                _mergeInProgress = true;
                const current = collectVideoBlobsInDomOrder();
                try {
                    const blobUrls = current.map(s => s.blobUrl);
                    const { rec: recText, concat: concatText } = getLang();
                    console.log('[SnapDL] Merging', blobUrls.length, 'segments:', blobUrls);
                    const merged = await mergeVideoSegments(blobUrls, ({ phase, done, total }) => {
                        if (phase === 'record') {
                            btn.innerHTML = `⏳ ${recText} ${done}/${total}`;
                            console.log(`[SnapDL] Fetching segment ${done}/${total}`);
                        } else {
                            btn.innerHTML = `⏳ ${concatText}`;
                            console.log('[SnapDL] Concatenating segments');
                        }
                    });
                    console.log('[SnapDL] Merged blob:', merged.size, 'bytes, type:', merged.type);
                    const mergedCt = merged.type || (current[0].meta && current[0].meta.contentType) || 'video/webm';
                    const [, mergedExt] = CONTENT_TYPE_MAP[mergedCt.split(';')[0]] || ['video', 'webm'];
                    const filename = buildFilename('video', mergedExt, current[0].meta, 'merged');
                    const objectUrl = origCreateObjectURL(merged);
                    console.log('[SnapDL] Download URL:', objectUrl, '→', filename);
                    triggerDownload(objectUrl, filename);
                    setTimeout(() => origRevokeObjectURL(objectUrl), 30000);
                    showToast(filename, !!(current[0].meta && current[0].meta.date));
                    btn.textContent = '✅';
                    setTimeout(() => { _mergeInProgress = false; btn.disabled = false; updateMergePanel(); }, 4000);
                } catch (err) {
                    console.error('[SnapDL] Merge failed:', err);
                    btn.textContent = `❌ ${err.message || 'Error'}`;
                    setTimeout(() => {
                        _mergeInProgress = false;
                        btn.disabled = false;
                        updateMergePanel();
                    }, 4000);
                }
            };
        }

        _mergePanel.innerHTML = `<span>⬇⬇</span> ${mergeText} (${segments.length})`;
    };

    // ── Button injection ──────────────────────────────────────────────────────

    const injectButtons = () => {
        const { btn: btnText } = getLang();

        document.querySelectorAll('img, video').forEach(el => {
            const src = el.currentSrc || el.src;
            if (!src || !src.startsWith('blob:')) return;
            if (el.dataset.snapDlReady) return;

            el.dataset.snapDlReady = 'true';
            const container = el.parentElement;
            if (!container) return;

            container.classList.add('snap-container-relative');
            const btn = document.createElement('button');
            btn.className = 'snap-dl-btn';
            btn.innerHTML = `<span>⬇</span> ${btnText}`;
            btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); downloadMedia(el).catch(err => console.error('[SnapDL] Download failed:', err)); };
            container.appendChild(btn);
        });

        updateMergePanel();
    };

    // ── Double-click shortcut ─────────────────────────────────────────────────

    document.addEventListener('dblclick', (e) => {
        const el = e.target;
        if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement) {
            downloadMedia(el).catch(err => console.error('[SnapDL] Download failed:', err));
        }
    }, true);

    // ── Init ──────────────────────────────────────────────────────────────────

    let _debounceTimer = null;
    const debouncedInject = () => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(injectButtons, 300);
    };

    const observer = new MutationObserver(debouncedInject);

    const init = () => {
        injectStyles();
        observer.observe(document.body, { childList: true, subtree: true });
        injectButtons();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
