(() => {
  const VERSION = 'v3.5';
  if (window.__bulkImgVersion === VERSION) return;
  window.__bulkImgVersion = VERSION;

  let running = false;
  let zipping = false;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log('[BulkImg]', ...a);

  document.querySelectorAll('.__bulkimg_badge').forEach(e => e.remove());
  const badge = document.createElement('div');
  badge.className = '__bulkimg_badge';
  badge.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#10a37f;color:#fff;padding:8px 12px;border-radius:8px;font:13px Arial;display:none;max-width:300px';
  document.documentElement.appendChild(badge);

  function status(text) {
    log(text);
    badge.textContent = text;
    badge.style.display = text ? 'block' : 'none';
    try { chrome.runtime.sendMessage({ type: 'progress', text }); } catch (e) {}
  }
  const hideBadgeLater = ms => setTimeout(() => { if (!running && !zipping) badge.style.display = 'none'; }, ms);

  async function waitFor(fn, timeout = 30000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (!running) return null;
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  const getBox = () =>
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"].ProseMirror') ||
    document.querySelector('textarea');

  const getSend = () =>
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send message"]');

  const getStop = () =>
    document.querySelector('button[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label="Stop streaming"]') ||
    document.querySelector('button[aria-label="Stop generating"]');

  const userCount = () => document.querySelectorAll('[data-message-author-role="user"]').length;
  const boxText = box => (box.tagName === 'TEXTAREA' ? box.value : box.innerText || '').trim();

  async function typePrompt(text) {
    const box = await waitFor(getBox, 15000);
    if (!box) return false;
    box.focus();
    await sleep(200);
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      if (!boxText(box)) {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    }
    await sleep(500);
    return boxText(box).length > 0;
  }

  async function submit() {
    const btn = await waitFor(() => {
      const b = getSend();
      return b && !b.disabled ? b : null;
    }, 8000);
    if (btn) { btn.click(); return true; }
    const box = getBox();
    if (!box) return false;
    box.focus();
    ['keydown', 'keypress', 'keyup'].forEach(t =>
      box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
    );
    return true;
  }

  async function waitForGeneration(before) {
    await waitFor(() => getStop() || userCount() > before, 30000, 300);
    const t0 = Date.now();
    let goneSince = null;
    while (running && Date.now() - t0 < 360000) {
      if (getStop()) {
        goneSince = null;
      } else {
        if (goneSince === null) goneSince = Date.now();
        if (Date.now() - goneSince >= 4000) break;
      }
      await sleep(500);
    }
  }

  // ---------- ZIP part ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // simple ZIP (store, no compression). PNG/JPG already compressed, tai eta-i jothesto.
  function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true);
      lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true);
      ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);

      offset += 30 + name.length + size;
    }

    let centralSize = 0;
    for (const c of central) centralSize += c.byteLength !== undefined ? c.byteLength : c.length;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  const keyOf = src => {
    try { return new URL(src, location.href).searchParams.get('id') || src; } catch (e) { return src; }
  };

  const IMG_URL_RE = /estuary|oaiusercontent|backend-api\/(content|files)|\/files\//i;

  function collectImages() {
    const seen = new Set();
    const urls = [];
    const stats = { total: 0, nosrc: 0, user: 0, ui: 0, small: 0, dup: 0 };
    const samples = [];

    document.querySelectorAll('img').forEach(img => {
      stats.total++;
      const src = img.currentSrc || img.src || '';
      if (samples.length < 15) samples.push({ src: src.slice(0, 120), w: img.naturalWidth, rw: Math.round(img.getBoundingClientRect().width), alt: (img.alt || '').slice(0, 40) });
      if (!src || src.startsWith('data:') || src.startsWith('blob:image/svg')) { stats.nosrc++; return; }
      if (img.closest('[data-message-author-role="user"]')) { stats.user++; return; }
      if (img.closest('nav, aside, header, form, [role="dialog"]')) { stats.ui++; return; }

      const rect = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, rect.width || 0, parseInt(img.getAttribute('width')) || 0);
      if (w < 200 && !IMG_URL_RE.test(src)) { stats.small++; return; }

      const key = keyOf(src);
      if (seen.has(key)) { stats.dup++; return; }
      seen.add(key);
      urls.push(src);
    });

    log('collectImages', stats, samples);
    urls.stats = stats;
    return urls;
  }

  let zipCancel = false;

  function getScroller() {
    let el = document.querySelector('[data-message-author-role], article');
    while (el && el !== document.documentElement && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  // lamba chat e sob image DOM e thake na, tai upor theke niche scroll kore prottek dhape image jomano hocche
  async function harvestAll(onProgress) {
    const scroller = getScroller();
    const originalTop = scroller.scrollTop;
    const found = new Map();
    const grab = () => {
      collectImages().forEach(u => {
        const k = keyOf(u);
        if (!found.has(k)) found.set(k, u);
      });
    };
    const scrollTo = y => scroller.scrollTo({ top: y, behavior: 'instant' });

    scrollTo(0);
    await sleep(1500);
    let lastTop = -1;
    let stuck = 0;
    for (let iter = 0; iter < 3000 && !zipCancel; iter++) {
      grab();
      onProgress(found.size);
      const step = Math.max(300, scroller.clientHeight * 0.7);
      scrollTo(scroller.scrollTop + step);
      await sleep(600);
      grab();
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
      if (atBottom) { await sleep(1000); grab(); break; }
      if (scroller.scrollTop === lastTop) { if (++stuck >= 4) break; } else { stuck = 0; }
      lastTop = scroller.scrollTop;
    }
    onProgress(found.size);
    scrollTo(scroller.scrollHeight);
    return [...found.values()];
  }

  async function downloadZip(scope) {
    if (zipping) { status('ZIP age theke toiri hocche...'); return; }
    zipping = true;
    zipCancel = false;
    try {
      let urls;
      if (scope === 'recent') {
        const d = await chrome.storage.local.get('runUrls');
        urls = d.runUrls || [];
        if (!urls.length) {
          status('Recent run e kono image nai. Age prompt Start kore chalao, ba "Ei chat er shob image" chapo.');
          return;
        }
      } else {
        urls = await harvestAll(n => status(`Chat scroll kore image khujchi... ${n} ta paoa gelo (tab bondho koro na)`));
        if (zipCancel) { status('ZIP cancel kora hoyeche.'); return; }
        if (!urls.length) {
          const st = collectImages().stats;
          status(`Image paoa jayni. Page e total img: ${st.total}, chhoto: ${st.small}, UI: ${st.ui}, src chhara: ${st.nosrc}. (F12 > Console e [BulkImg] dekho)`);
          return;
        }
      }

      const files = [];
      let failed = 0;
      let lastErr = '';
      for (let i = 0; i < urls.length; i++) {
        if (zipCancel) { status('ZIP cancel kora hoyeche.'); return; }
        status(`Image ${i + 1}/${urls.length} nameche...`);
        try {
          const res = await fetch(urls[i], { credentials: 'include' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const ext = ((blob.type.split('/')[1] || 'png').split('+')[0]).replace('jpeg', 'jpg');
          const data = new Uint8Array(await blob.arrayBuffer());
          files.push({ name: `image-${String(files.length + 1).padStart(3, '0')}.${ext}`, data });
        } catch (e) {
          failed++;
          log('image download fail', urls[i], e);
          lastErr = (e && e.message) ? e.message : String(e);
        }
      }
      if (!files.length) { status('Kono image namano jayni (' + lastErr + '). Page refresh kore abar try koro.'); return; }

      status('ZIP file toiri hocche...');
      const zip = makeZip(files);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = URL.createObjectURL(zip);
      a.download = `chatgpt-images-${stamp}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      status(`ZIP ready: ${files.length} ta image` + (failed ? ` (${failed} ta namano jayni)` : ''));
    } catch (e) {
      status('ZIP error: ' + (e && e.message ? e.message : e));
    } finally {
      zipping = false;
      hideBadgeLater(10000);
    }
  }
  // ---------- ZIP part end ----------

  async function run(prompts, prefix, delay, autozip) {
    running = true;

    // ei run er age page e jei image gulo chhilo, segulo baad
    const baseline = new Set(collectImages().map(keyOf));
    const runKeys = new Set();
    const runUrls = [];
    await chrome.storage.local.set({ runUrls: [] });
    const scan = async () => {
      collectImages().forEach(u => {
        const k = keyOf(u);
        if (!baseline.has(k) && !runKeys.has(k)) { runKeys.add(k); runUrls.push(u); }
      });
      await chrome.storage.local.set({ runUrls });
    };

    for (let i = 0; i < prompts.length && running; i++) {
      const n = `${i + 1}/${prompts.length}`;
      status(`Prompt ${n}: type kora hocche...`);
      const ok = await typePrompt(prefix + prompts[i]);
      if (!ok) { status('ERROR: prompt box e likhte pari ni. Page refresh (F5) kore abar try koro.'); running = false; break; }

      const before = userCount();
      status(`Prompt ${n}: send kora hocche...`);
      const sent = await submit();
      if (!sent) { status('ERROR: send korte pari ni.'); running = false; break; }

      status(`Prompt ${n}: image generate hocche...`);
      await waitForGeneration(before);
      await sleep(1000);
      await scan();
      if (!running) break;
      await sleep(delay * 1000);
    }
    const finished = running;
    running = false;
    try { await sleep(1500); await scan(); } catch (e) {}
    if (finished) {
      status(`Sesh! ${prompts.length} ta prompt complete. ${runUrls.length} ta image paoa gelo.`);
      if (autozip) {
        await sleep(1500);
        await downloadZip('recent');
      }
    }
    hideBadgeLater(10000);
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'start') {
      if (running) { status('Age theke cholche.'); return; }
      status('Start message peyechi, shuru korchi...');
      run(msg.prompts, msg.prefix || '', msg.delay || 0, !!msg.autozip);
    }
    if (msg.type === 'stop') { running = false; zipCancel = true; status('Stop kora hoyeche.'); }
    if (msg.type === 'zip') downloadZip(msg.scope || 'all');
  });

  status('Extension ready.');
  hideBadgeLater(3000);
})();
