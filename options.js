const $ = (id) => document.getElementById(id);
const status = $('status');

function setStatus(text, cls = '') {
  status.textContent = text;
  status.className = cls;
}

function refreshTexts() {
  applyI18n();
  document.title = t('optTitle');
  $('toggleKey').textContent = t($('apiKey').type === 'password' ? 'show' : 'hide');
  setStatus('');
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
  await chrome.storage.local.remove('autoShorts'); // old setting, no longer used
  await chrome.storage.local.set({
    shortsDelay,
    language: currentLang,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || DEFAULTS.model,
    autoAnalyze: $('autoAnalyze').checked,
    showDetails: $('showDetails').checked
  });
  setStatus(t('saved'), 'ok');
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
});

load();
