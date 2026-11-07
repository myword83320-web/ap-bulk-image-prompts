const $ = id => document.getElementById(id);


// ---- prompt split logic ----
const HEADING_RE = /^\s*(?:prompt|image|scene|page|idea)?\s*#?\s*\d+\s*[:.)\-\u2013\u2014]\s*(.*)$/i;

function clean(lines) {
  return lines.map(s => s.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function parsePrompts(text, mode) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headingCount = lines.filter(l => HEADING_RE.test(l)).length;
  const hasBlank = /\n\s*\n/.test(text.trim());

  if (mode === 'auto') {
    if (headingCount >= 2) mode = 'heading';
    else if (hasBlank) mode = 'blank';
    else mode = 'line';
  }

  if (mode === 'line') {
    return lines.map(s => s.trim()).filter(Boolean);
  }
  if (mode === 'blank') {
    return text.replace(/\r/g, '').split(/\n\s*\n/).map(b => clean(b.split('\n'))).filter(Boolean);
  }
  // heading mode: "Prompt 12:" theke shuru kore porer heading porjonto ek prompt
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (cur) blocks.push(cur);
      cur = [m[1] || ''];
    } else if (line.trim()) {
      if (!cur) cur = [];
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map(clean).filter(Boolean);
}

function refreshCount() {
  const p = parsePrompts($('prompts').value, $('mode').value);
  $('count').textContent = `${p.length} ta prompt paoa gelo`;
  $('preview').textContent = p.length ? 'Prothom prompt: ' + p[0].slice(0, 140) + (p[0].length > 140 ? '...' : '') : '';
}

chrome.storage.local.get(['prompts', 'prefix', 'delay', 'autozip', 'mode', 'promptScroll', 'promptCaret'], d => {
  if (d.prompts) $('prompts').value = d.prompts;
  if (d.prefix !== undefined) $('prefix').value = d.prefix;
  if (d.delay !== undefined) $('delay').value = d.delay;
  $('autozip').checked = !!d.autozip;
  if (d.mode) $('mode').value = d.mode;
  refreshCount();

  // popup khulle textbox ager jaygay (na thakle shesh prompt e) fire jabe
  setTimeout(() => {
    const ta = $('prompts');
    ta.focus();
    if (typeof d.promptScroll === 'number' && d.prompts) {
      const pos = Math.min(d.promptCaret || 0, ta.value.length);
      ta.setSelectionRange(pos, pos);
      ta.scrollTop = d.promptScroll;
    } else {
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollTop = ta.scrollHeight;
    }
  }, 50);
});

// prompt, prefix, wait sob kichu likhar sathe sathei save hoy, popup bondho hole-o hariye jay na
let saveTimer = null;
function saveFields() {
  chrome.storage.local.set({
    prompts: $('prompts').value,
    prefix: $('prefix').value,
    delay: Number($('delay').value) || 0,
    promptScroll: $('prompts').scrollTop,
    promptCaret: $('prompts').selectionStart
  });
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFields, 200);
}
$('prompts').addEventListener('input', () => { refreshCount(); saveSoon(); });
$('prompts').addEventListener('scroll', saveSoon);
$('prompts').addEventListener('keyup', saveSoon);
$('prompts').addEventListener('click', saveSoon);
$('prefix').addEventListener('input', saveSoon);
$('delay').addEventListener('input', saveSoon);
window.addEventListener('pagehide', saveFields);
$('mode').addEventListener('change', () => { chrome.storage.local.set({ mode: $('mode').value }); refreshCount(); });

async function send(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/chatgpt\.com|chat\.openai\.com/.test(tab.url || '')) {
    $('status').textContent = 'Age ChatGPT tab (chatgpt.com) open koro, tarpor ekhane eso.';
    return false;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch (e) {
    $('status').textContent = 'Error: ' + (e && e.message ? e.message : e);
    return false;
  }
}

$('start').onclick = async () => {
  const text = $('prompts').value;
  const prompts = parsePrompts(text, $('mode').value);
  if (!prompts.length) { $('status').textContent = 'Kono prompt nai.'; return; }
  const prefix = $('prefix').value;
  const delay = Number($('delay').value) || 0;
  const autozip = $('autozip').checked;
  chrome.storage.local.set({ prompts: text, prefix, delay, autozip, lastRunCount: prompts.length });
  if (await send({ type: 'start', prompts, prefix, delay, autozip })) {
    $('status').textContent = 'Message pathano hoyeche, page er nichey dekho.';
  }
};

$('stop').onclick = () => send({ type: 'stop' });

$('clear').onclick = () => {
  $('prompts').value = '';
  chrome.storage.local.remove(['prompts', 'runUrls', 'lastRunCount', 'promptScroll', 'promptCaret']);
  refreshCount();
  $('status').textContent = 'Prompt ar recent run er record clear kora hoyeche.';
  $('prompts').focus();
};

$('autozip').onchange = () => chrome.storage.local.set({ autozip: $('autozip').checked });

$('zipRecent').onclick = async () => {
  await send({ type: 'zip', scope: 'recent' });
};

function refreshRecent() {
  chrome.storage.local.get(['runUrls'], d => {
    $('zipRecent').textContent = `Recent run er image (${(d.runUrls || []).length})`;
  });
}
refreshRecent();
chrome.storage.onChanged.addListener(ch => { if (ch.runUrls) refreshRecent(); });

chrome.runtime.onMessage.addListener(m => {
  if (m.type === 'progress') $('status').textContent = m.text;
});
