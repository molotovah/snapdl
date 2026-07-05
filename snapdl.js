// ==UserScript==
// @name         Snapchat Image & Video Downloader (HD)
// @name:fr      Snapchat Téléchargeur d'images et de vidéos (HD)
// @namespace    https://github.com/Molotovah
// @version      3.16.0
// @description  Download Snapchat images and videos in full resolution, in their original format, via your browser's download manager.
// @description:fr Téléchargez images et vidéos Snapchat en pleine résolution, dans leur format d'origine, via le gestionnaire de téléchargements du navigateur.
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
    // We tag each blob: URL via a Map so date + content-type can be resolved
    // later, without a second network fetch, when the download button fires.

    const blobUrlMeta = new Map(); // "blob:…" → { date?, sourceUrl?, contentType? }

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
        if (meta.date || meta.sourceUrl || meta.contentType) blob.__snapDlMeta = meta;
        return blob;
    };

    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (source) {
        const url = origCreateObjectURL(source);
        if (source && source.__snapDlMeta) blobUrlMeta.set(url, source.__snapDlMeta);
        return url;
    };

    const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = function (url) {
        blobUrlMeta.delete(url);
        origRevokeObjectURL(url);
    };

    // ── i18n ─────────────────────────────────────────────────────────────────

    const translations = {
        en: { btn: 'Download', toast: 'Downloading' },
        tr: { btn: 'İndir', toast: 'İndiriliyor' },
        es: { btn: 'Descargar', toast: 'Descargando' },
        fr: { btn: 'Télécharger', toast: 'Téléchargement' },
        de: { btn: 'Herunterladen', toast: 'Wird heruntergeladen' },
        pt: { btn: 'Baixar', toast: 'Baixando' },
        ru: { btn: 'Скачать', toast: 'Скачивание' },
        zh: { btn: '下载', toast: '下载中' },
        hi: { btn: 'डाउनलोड', toast: 'डाउनलोड हो रहा है' },
        ar: { btn: 'تنزيل', toast: 'جارٍ التنزيل' },
        ja: { btn: 'ダウンロード', toast: 'ダウンロード中' },
        ko: { btn: '다운로드', toast: '다운로드 중' },
        bn: { btn: 'ডাউনলোড', toast: 'ডাউনলোড হচ্ছে' },
        it: { btn: 'Scarica', toast: 'Scaricamento' },
        id: { btn: 'Unduh', toast: 'Mengunduh' }
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

    const buildFilename = (type, ext, meta) => {
        const convName = getConversationName();
        const convPart = convName ? `${sanitizeFilenameSegment(convName)}_` : '';
        return `snapchat_${convPart}${type}_${formatDate((meta && meta.date) || new Date())}.${ext}`;
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
    // a.click() is required to trigger <a download> activation behavior in
    // Firefox and Chrome alike — this hands the blob straight to the browser's
    // native download manager, byte-for-byte, no re-encode/conversion of any
    // kind. dispatchEvent(new MouseEvent) does NOT reliably trigger downloads.
    // A capture-phase handler on document stops the click from reaching
    // Snapchat's SPA router (React bubble-phase listener on document) before
    // it can navigate.

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

    // ── Media download ────────────────────────────────────────────────────────
    // Detects real Content-Type from blob URL headers so WebM video isn't saved
    // as .mp4 (wrong extension → decoder mismatch → audio only, black video).
    // The blob itself is downloaded as-is — original resolution and codec,
    // never transcoded.

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
