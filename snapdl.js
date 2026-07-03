// ==UserScript==
// @name         Snapchat Image & Video Downloader (HD)
// @name:fr      Snapchat Téléchargeur d'images et de vidéos (HD)
// @namespace    https://github.com/Molotovah
// @version      3.14.0
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

    // Snapchat's feed is virtualized: once the user scrolls past a split-video
    // segment, its <video> gets unmounted (and often its blob: URL revoked) to
    // free memory. Waiting until merge-click time to fetch each segment (the
    // old approach) meant only the still-mounted segment was ever available,
    // so "merge" silently downloaded a single segment instead. Capture each
    // segment's Blob content the moment it's first seen, independent of DOM
    // survival, and merge from this cache instead of re-querying the DOM.
    const capturedSegments = []; // [{ blobUrl, blob, meta, thumb }] in first-seen order
    const _selectedBlobUrls = new Set(); // segments the user has checked for the next merge

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
    // Snapchat uses opaque CDN URLs. The floating panel lets the user merge
    // segments explicitly after scrolling through all of them to load them.

    // Grabs a single frame as a small JPEG data URL so the merge picker can
    // show *which* video is which — segments have no other identifying label.
    const generateThumbnail = (blob) => new Promise((resolve) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        const url = origCreateObjectURL(blob);
        const done = (dataUrl) => { origRevokeObjectURL(url); video.remove(); resolve(dataUrl); };
        video.addEventListener('loadeddata', () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 80;
                canvas.height = Math.round(80 * ((video.videoHeight / video.videoWidth) || 0.5625));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                done(canvas.toDataURL('image/jpeg', 0.6));
            } catch (e) { done(null); }
        }, { once: true });
        video.addEventListener('error', () => done(null), { once: true });
        video.src = url;
    });

    // Fetches and caches a video segment's Blob the first time its blob: URL
    // is seen. Safe to call repeatedly — dedupes on blobUrl.
    const captureVideoSegment = (src) => {
        if (capturedSegments.some(s => s.blobUrl === src)) return;
        const placeholder = { blobUrl: src, blob: null, meta: blobUrlMeta.get(src), thumb: null };
        capturedSegments.push(placeholder);
        fetch(src).then(r => r.blob()).then(blob => {
            placeholder.blob = blob;
            _selectedBlobUrls.add(src); // captured segments are merge-selected by default
            console.log('[SnapDL] Captured segment', capturedSegments.length, 'size:', blob.size);
            updateMergePanel();
            generateThumbnail(blob).then(thumb => { placeholder.thumb = thumb; updateMergePanel(); });
        }).catch(e => {
            console.warn('[SnapDL] Segment capture failed:', e.message);
            const idx = capturedSegments.indexOf(placeholder);
            if (idx >= 0) capturedSegments.splice(idx, 1);
        });
    };

    // ── Merge: re-encode via canvas + MediaRecorder ───────────────────────────
    // Real Snapchat segments turned out to be standalone, complete MP4 files
    // (no `moof` box at all in most of them — that's why byte-level fMP4
    // concatenation kept failing to find one), not true DASH/CMAF fragments.
    // Byte-level splicing of independent MP4/WebM files can't produce a
    // container that plays past the first file without a real muxer, which a
    // userscript can't reasonably ship. Instead: play each segment through a
    // hidden <video>, draw its frames to a <canvas>, pipe canvas + WebAudio
    // output into one continuous MediaRecorder stream. Works regardless of
    // source container/codec, at the cost of a real-time re-encode pass.

    const reencodeSegments = (blobs, onProgress) => new Promise((resolve, reject) => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        const dest = audioCtx.createMediaStreamDestination();
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
        document.body.appendChild(video);

        let audioSource = null; // an element can only be wrapped by one MediaElementSourceNode, ever
        let rafId = null;
        let stopped = false;

        const cleanup = () => {
            if (stopped) return;
            stopped = true;
            if (rafId) cancelAnimationFrame(rafId);
            video.pause();
            video.remove();
            audioCtx.close().catch(() => {});
        };

        const drawLoop = () => {
            if (stopped) return;
            if (canvas.width && !video.paused && !video.ended) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            }
            rafId = requestAnimationFrame(drawLoop);
        };

        const canvasStream = canvas.captureStream(30);
        const mixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
            .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || 'video/webm';
        const recorder = new MediaRecorder(mixedStream, { mimeType });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => { cleanup(); resolve(new Blob(chunks, { type: mimeType })); };

        const playOne = (blob) => new Promise((res, rej) => {
            const url = origCreateObjectURL(blob);
            const onLoaded = () => {
                canvas.width = video.videoWidth || canvas.width || 640;
                canvas.height = video.videoHeight || canvas.height || 360;
                if (!audioSource) { audioSource = audioCtx.createMediaElementSource(video); audioSource.connect(dest); }
                video.play().catch(onError);
            };
            const onEnded = () => { teardown(); res(); };
            const onError = (e) => { teardown(); rej(e instanceof Error ? e : new Error('Segment playback failed')); };
            const teardown = () => {
                video.removeEventListener('loadedmetadata', onLoaded);
                video.removeEventListener('ended', onEnded);
                video.removeEventListener('error', onError);
                origRevokeObjectURL(url);
            };
            video.addEventListener('loadedmetadata', onLoaded, { once: true });
            video.addEventListener('ended', onEnded, { once: true });
            video.addEventListener('error', onError, { once: true });
            video.src = url;
            video.load();
        });

        (async () => {
            try {
                recorder.start();
                rafId = requestAnimationFrame(drawLoop);
                for (let i = 0; i < blobs.length; i++) {
                    onProgress && onProgress({ done: i + 1, total: blobs.length });
                    console.log('[SnapDL] Re-encoding segment', i + 1, '/', blobs.length);
                    await playOne(blobs[i]);
                }
                recorder.stop();
            } catch (e) {
                cleanup();
                reject(e);
            }
        })();
    });

    // ── Merge orchestrator ────────────────────────────────────────────────────

    // `blobs` are already-fetched segment Blobs, captured as each segment's
    // <video> first mounted (see captureVideoSegment) — merge no longer
    // re-fetches blob: URLs, which may be stale/revoked by merge-click time.
    const mergeVideoSegments = (blobs, onProgress) => {
        if (blobs.length === 1) return Promise.resolve(blobs[0]);
        return reencodeSegments(blobs, onProgress);
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
                background: rgba(10, 10, 10, 0.92);
                color: #fffc00;
                border: 1px solid rgba(255, 252, 0, 0.6);
                border-radius: 8px;
                padding: 10px;
                font-size: 13px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                backdrop-filter: blur(8px);
                width: 220px;
            }
            .snap-dl-merge-header { font-weight: bold; margin-bottom: 6px; }
            .snap-dl-merge-list {
                max-height: 220px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 4px;
                margin-bottom: 8px;
            }
            .snap-dl-merge-item {
                display: flex;
                align-items: center;
                gap: 6px;
                color: #fff;
                cursor: pointer;
                padding: 3px;
                border-radius: 4px;
            }
            .snap-dl-merge-item:hover { background: rgba(255, 255, 255, 0.08); }
            .snap-dl-merge-thumb {
                width: 40px;
                height: 24px;
                object-fit: cover;
                border-radius: 3px;
                background: #222;
                flex: none;
            }
            .snap-dl-merge-thumb--empty { display: inline-block; }
            .snap-dl-merge-label { font-size: 12px; flex: 1; }
            .snap-dl-merge-remove {
                background: none;
                border: none;
                color: rgba(255, 255, 255, 0.6);
                cursor: pointer;
                font-size: 14px;
                line-height: 1;
                padding: 2px 4px;
            }
            .snap-dl-merge-remove:hover { color: #fff; }
            .snap-dl-merge-actions { display: flex; gap: 6px; }
            .snap-dl-merge-actions button {
                background: rgba(255, 255, 255, 0.1);
                color: #fffc00;
                border: 1px solid rgba(255, 252, 0, 0.6);
                border-radius: 6px;
                padding: 6px 10px;
                font-size: 12px;
                font-weight: bold;
                cursor: pointer;
            }
            .snap-dl-merge-actions button:hover:not(:disabled) { background: rgba(255, 252, 0, 0.15); }
            .snap-dl-merge-actions button:disabled { opacity: 0.65; cursor: default; }
            .snap-dl-merge-actions [data-action="go"] { flex: 1; }
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
    // Appears fixed bottom-right whenever 2+ video segments have been captured.
    // Captured segments accumulate for as long as the user scrolls the chat —
    // not just one split story — so the panel lists every one with a thumbnail
    // and a checkbox: the user picks exactly which ones to merge instead of
    // everything ever seen this session getting mashed together.

    let _mergePanel = null;
    let _mergeInProgress = false;
    // injectButtons() calls updateMergePanel() on every DOM mutation Snapchat's
    // SPA fires — including plain scrolling, unrelated to segments — so most
    // calls have nothing new to show. Rebuilding innerHTML anyway would reset
    // .snap-dl-merge-list's scrollTop to 0 on every one of those, making the
    // list unscrollable. Skip the rebuild entirely when nothing changed.
    let _lastPanelKey = '';

    const readySegments = () => capturedSegments.filter(s => s.blob);

    const updateMergePanel = () => {
        if (_mergeInProgress) return;
        const segments = readySegments();
        const { merge: mergeText } = getLang();

        if (segments.length < 2) {
            if (_mergePanel) { _mergePanel.remove(); _mergePanel = null; }
            _lastPanelKey = '';
            return;
        }

        const panelKey = segments
            .map(s => `${s.blobUrl}:${s.thumb ? 1 : 0}:${_selectedBlobUrls.has(s.blobUrl) ? 1 : 0}`)
            .join('|');
        if (_mergePanel && panelKey === _lastPanelKey) return;
        _lastPanelKey = panelKey;

        const existingList = _mergePanel && _mergePanel.querySelector('.snap-dl-merge-list');
        const savedScrollTop = existingList ? existingList.scrollTop : 0;

        if (!_mergePanel) {
            _mergePanel = document.createElement('div');
            _mergePanel.className = 'snap-dl-merge-panel';
            document.body.appendChild(_mergePanel);
        }

        const selectedCount = segments.filter(s => _selectedBlobUrls.has(s.blobUrl)).length;
        const updateCount = () => {
            const el = _mergePanel.querySelector('[data-role="count"]');
            if (el) el.textContent = segments.filter(s => _selectedBlobUrls.has(s.blobUrl)).length;
        };

        _mergePanel.innerHTML = `
            <div class="snap-dl-merge-header">${mergeText} — <span data-role="count">${selectedCount}</span>/${segments.length}</div>
            <div class="snap-dl-merge-list"></div>
            <div class="snap-dl-merge-actions">
                <button type="button" data-action="clear">✕</button>
                <button type="button" data-action="go">⬇⬇ ${mergeText}</button>
            </div>
        `;

        const list = _mergePanel.querySelector('.snap-dl-merge-list');
        segments.forEach((seg, i) => {
            const row = document.createElement('label');
            row.className = 'snap-dl-merge-item';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = _selectedBlobUrls.has(seg.blobUrl);
            cb.onchange = () => {
                if (cb.checked) _selectedBlobUrls.add(seg.blobUrl);
                else _selectedBlobUrls.delete(seg.blobUrl);
                updateCount();
            };
            row.appendChild(cb);

            if (seg.thumb) {
                const img = document.createElement('img');
                img.src = seg.thumb;
                img.className = 'snap-dl-merge-thumb';
                row.appendChild(img);
            } else {
                const ph = document.createElement('span');
                ph.className = 'snap-dl-merge-thumb snap-dl-merge-thumb--empty';
                row.appendChild(ph);
            }

            const label = document.createElement('span');
            label.className = 'snap-dl-merge-label';
            label.textContent = `#${i + 1} · ${(seg.blob.size / 1e6).toFixed(1)}MB`;
            row.appendChild(label);

            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'snap-dl-merge-remove';
            rm.textContent = '×';
            rm.onclick = (e) => {
                e.preventDefault();
                _selectedBlobUrls.delete(seg.blobUrl);
                const idx = capturedSegments.indexOf(seg);
                if (idx >= 0) capturedSegments.splice(idx, 1);
                updateMergePanel();
            };
            row.appendChild(rm);

            list.appendChild(row);
        });
        list.scrollTop = savedScrollTop;

        _mergePanel.querySelector('[data-action="clear"]').onclick = () => {
            capturedSegments.length = 0;
            _selectedBlobUrls.clear();
            updateMergePanel();
        };

        _mergePanel.querySelector('[data-action="go"]').onclick = async () => {
            const goBtn = _mergePanel.querySelector('[data-action="go"]');
            const chosen = segments.filter(s => _selectedBlobUrls.has(s.blobUrl));
            if (chosen.length < 2) {
                showToast('Select at least 2 videos', true);
                return;
            }
            goBtn.disabled = true;
            _mergeInProgress = true;
            try {
                const blobs = chosen.map(s => s.blob);
                const { concat: concatText } = getLang();
                console.log('[SnapDL] Merging', blobs.length, 'segments');
                const merged = await mergeVideoSegments(blobs, ({ done, total }) => {
                    goBtn.textContent = `⏳ ${concatText} ${done}/${total}`;
                });
                console.log('[SnapDL] Merged blob:', merged.size, 'bytes, type:', merged.type);
                const mergedCt = merged.type || (chosen[0].meta && chosen[0].meta.contentType) || 'video/webm';
                const [, mergedExt] = CONTENT_TYPE_MAP[mergedCt.split(';')[0]] || ['video', 'webm'];
                const filename = buildFilename('video', mergedExt, chosen[0].meta, 'merged');
                const objectUrl = origCreateObjectURL(merged);
                console.log('[SnapDL] Download URL:', objectUrl, '→', filename);
                triggerDownload(objectUrl, filename);
                setTimeout(() => origRevokeObjectURL(objectUrl), 30000);
                showToast(filename, !!(chosen[0].meta && chosen[0].meta.date));
                chosen.forEach(s => {
                    _selectedBlobUrls.delete(s.blobUrl);
                    const idx = capturedSegments.indexOf(s);
                    if (idx >= 0) capturedSegments.splice(idx, 1);
                });
                _mergeInProgress = false;
                updateMergePanel();
            } catch (err) {
                console.error('[SnapDL] Merge failed:', err);
                showToast(`Merge failed: ${err.message || 'Error'}`, true);
                _mergeInProgress = false;
                goBtn.disabled = false;
                goBtn.textContent = `⬇⬇ ${mergeText}`;
            }
        };
    };

    // ── Button injection ──────────────────────────────────────────────────────

    const injectButtons = () => {
        const { btn: btnText } = getLang();

        document.querySelectorAll('img, video').forEach(el => {
            const src = el.currentSrc || el.src;
            if (!src || !src.startsWith('blob:')) return;
            if (el.dataset.snapDlReady) return;

            el.dataset.snapDlReady = 'true';
            if (el instanceof HTMLVideoElement) captureVideoSegment(src);
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
