const $ = (id) => document.getElementById(id);
const status = $('status');

function setStatus(text, cls = '') {
  status.textContent = text;
  status.className = cls;
}

$('cacheMax').min = CACHE_MIN;
$('cacheMax').max = CACHE_LIMIT;

// Shows how many analyses are stored right now versus the saved limit.
async function paintCacheInfo() {
  const { cache = {}, cacheMax } = await chrome.storage.local.get({ cache: {}, cacheMax: DEFAULTS.cacheMax });
  $('cacheInfo').textContent = t('cacheInfo', Object.keys(cache).length, cacheMax);
}

function refreshTexts() {
  applyI18n();
  document.title = t('optTitle');
  $('toggleKey').textContent = t($('apiKey').type === 'password' ? 'show' : 'hide');
  setStatus('');
  $('cacheMaxHint').textContent = t('cacheMaxHint', CACHE_MIN, CACHE_LIMIT);
  paintCacheInfo();
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  setLang(s.language);
  fillLangSelect($('language'));
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('autoAnalyze').checked = s.autoAnalyze;
  $('showDetails').checked = s.showDetails;
  $('shortsDelay').value = s.shortsDelay;
  $('cacheMax').value = s.cacheMax;
  refreshTexts();
}

// Preview the chosen language right away; it's persisted with "Save".
$('language').addEventListener('change', () => {
  setLang($('language').value);
  refreshTexts();
});

$('toggleKey').addEventListener('click', () => {
  const input = $('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = t(input.type === 'password' ? 'show' : 'hide');
});

$('save').addEventListener('click', async () => {
  const delay = parseInt($('shortsDelay').value, 10);
  const shortsDelay = Number.isFinite(delay) ? Math.max(0, Math.min(60, delay)) : DEFAULTS.shortsDelay;
  $('shortsDelay').value = shortsDelay;
  const max = parseInt($('cacheMax').value, 10);
  const cacheMax = Number.isFinite(max) ? Math.max(CACHE_MIN, Math.min(CACHE_LIMIT, max)) : DEFAULTS.cacheMax;
  $('cacheMax').value = cacheMax;
  const { cache = {} } = await chrome.storage.local.get('cache');
  await chrome.storage.local.remove('autoShorts'); // old setting, no longer used
  await chrome.storage.local.set({
    shortsDelay,
    cacheMax,
    cache: trimCache(cache, cacheMax), // lowering the limit drops the oldest extras at once
    language: currentLang,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    autoAnalyze: $('autoAnalyze').checked,
    showDetails: $('showDetails').checked
  });
  setStatus(t('saved'), 'ok');
  paintCacheInfo();
});

// Listing models doesn't consume generation quota, so it's a free way to validate the key.
$('test').addEventListener('click', async () => {
  const key = $('apiKey').value.trim();
  if (!key) return setStatus(t('enterKeyFirst'), 'err');
  setStatus(t('checking'));
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': key }
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

    const names = (j.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''));
    const list = $('models');
    list.replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));

    const model = $('model').value.trim() || DEFAULTS.model;
    const known = names.includes(model);
    setStatus(t(known ? 'keyOkModel' : 'keyOkNoModel', model), known ? 'ok' : 'err');
  } catch (e) {
    setStatus(t('errorPrefix', e.message), 'err');
  }
});

$('clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove('cache');
  setStatus(t('cacheCleared'), 'ok');
  paintCacheInfo();
});

load();
