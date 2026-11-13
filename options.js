const $ = (id) => document.getElementById(id);
const status = $('status');

function setStatus(text, cls = '') {
  status.textContent = text;
  status.className = cls;
}

$('cacheMax').min = CACHE_MIN;
$('cacheMax').max = CACHE_LIMIT;

// Only the listed models can be chosen; a previously saved model that is no longer offered shows as the default.
function fillModelSelect(current) {
  $('model').replaceChildren(...MODEL_CHOICES.map((n) =>
    Object.assign(document.createElement('option'), { value: n, textContent: n })));
  $('model').value = normalizeModel(current);
}

const selectedModel = () => normalizeModel($('model').value);

// Price shown next to each model, from MODEL_PRICES (plus an upcoming change, if one is scheduled).
function paintModelPrices() {
  const fmt = (n) => n.toLocaleString(LANGS[currentLang].locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const today = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('[data-price-for]').forEach((el) => {
    const tiers = MODEL_PRICES[el.dataset.priceFor] || [];
    const now = priceFor(el.dataset.priceFor);
    const next = tiers.find((p) => p.from > today);
    el.textContent = !now ? '' : [
      t('modelPrice', fmt(now.input), fmt(now.output)),
      next && t('modelPriceFrom', new Date(next.from).toLocaleDateString(LANGS[currentLang].locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }), fmt(next.input), fmt(next.output))
    ].filter(Boolean).join(' ');
  });
}

// Shows how many analyses are stored right now versus the saved limit.
async function paintCacheInfo() {
  const { cache = {}, cacheMax } = await chrome.storage.local.get({ cache: {}, cacheMax: DEFAULTS.cacheMax });
  $('cacheInfo').textContent = t('cacheInfo', Object.keys(cache).length, cacheMax);
}

// Cumulative token usage recorded by the service worker: this month + everything since tracking began.
// tokenUsage = { since, months: { '2026-11': { '<model>': { calls, input, output, cost } } } }; cost is the
// USD estimate computed at call time with the paid-tier price in effect then.
async function paintUsage() {
  const { tokenUsage } = await chrome.storage.local.get('tokenUsage');
  const buckets = (months) => months.flatMap((m) => Object.values(m || {}));
  const all = buckets(Object.values(tokenUsage?.months || {}));
  if (all.length === 0) {
    $('usageMonth').textContent = t('usageNone');
    $('usageTotal').textContent = '';
    $('resetUsage').hidden = true;
    return;
  }
  const locale = LANGS[currentLang].locale;
  const num = (n) => n.toLocaleString(locale);
  const usd = (n) => n.toLocaleString(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const sum = (list) => list.reduce((a, b) => ({
    calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, cost: a.cost + (b.cost || 0)
  }), { calls: 0, input: 0, output: 0, cost: 0 });
  const month = sum(buckets([tokenUsage.months[monthKey()]]));
  const total = sum(all);
  $('usageMonth').textContent = t('usageMonth', num(month.calls), num(month.input), num(month.output), usd(month.cost));
  $('usageTotal').textContent = t('usageTotal', new Date(tokenUsage.since).toLocaleDateString(locale),
    num(total.calls), num(total.input), num(total.output), usd(total.cost));
  $('resetUsage').hidden = false;
}

$('resetUsage').addEventListener('click', async () => {
  if (!confirm(t('usageResetConfirm'))) return;
  await chrome.storage.local.remove('tokenUsage');
  setStatus(t('usageResetDone'), 'ok');
  paintUsage();
});

// Keep the numbers current while the settings page stays open during analyses.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tokenUsage) paintUsage();
});

function refreshTexts() {
  applyI18n();
  document.title = t('optTitle');
  $('toggleKey').textContent = t($('apiKey').type === 'password' ? 'show' : 'hide');
  setStatus('');
  $('cacheMaxHint').textContent = t('cacheMaxHint', CACHE_MIN, CACHE_LIMIT);
  paintCacheInfo();
  paintModelPrices();
  paintUsage();
}

async function load() {
  await chrome.storage.local.remove('usage'); // interim counter format without cost, superseded by tokenUsage
  const s = await chrome.storage.local.get(DEFAULTS);
  setLang(s.language);
  fillLangSelect($('language'));
  $('apiKey').value = s.apiKey;
  fillModelSelect(s.model);
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
    model: selectedModel(),
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

    const model = selectedModel();
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
