const CATEGORY_COLORS = {
  verified_news:   'var(--green)',
  news_unverified: 'var(--amber)',
  opinion:         'var(--blue)',
  educational:     'var(--green)',
  entertainment:   'var(--purple)',
  satire:          'var(--purple)',
  promotional:     'var(--gray)',
  misleading:      'var(--red)',
  fake:            'var(--red)'
};

const view = document.getElementById('view');
const refreshBtn = document.getElementById('refresh');
const langSelect = document.getElementById('lang');
let currentTab = null;
let showDetails = DEFAULTS.showDetails; // "Show Details" setting: key points are listed only when on

const copyBtn = document.getElementById('copy');
let shareText = ''; // WhatsApp-formatted summary of the result on screen

document.getElementById('close').addEventListener('click', () => window.close());
refreshBtn.addEventListener('click', () => run(true));
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareText);
    copyBtn.textContent = t('copied');
    setTimeout(() => { copyBtn.textContent = t('copy'); }, 1500);
  } catch (e) {
    console.warn('YouTruth: copy failed', e);
  }
});
langSelect.addEventListener('change', async () => {
  setLang(langSelect.value);
  applyI18n();
  await chrome.storage.local.set({ language: currentLang });
  run(); // served from cache if this video was already analyzed in that language
});

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// AI text marks emphasis with *asterisks* (or **double**). Turn it into text nodes and <strong>
// elements – never innerHTML, since the text comes from an AI. Unpaired asterisks are dropped.
function emphasize(text) {
  const parts = String(text ?? '').split(/\*{1,2}(?=\S)([^*\n]*?\S)\*{1,2}/g);
  // split() with one capture group alternates: plain, emphasized, plain, emphasized, ...
  return parts.map((p, i) => (i % 2 ? el('strong', {}, p) : p.replace(/\*/g, '')));
}
const plain = (text) => String(text ?? '').replace(/\*/g, ''); // for attributes (tooltips)

function show(...nodes) {
  // Skip falsy entries from `cond && el(...)`; replaceChildren would print them as "false".
  view.replaceChildren(...nodes.filter(Boolean));
}

function showMessage(text, { error = false, action } = {}) {
  show(el('div', { class: 'center' },
    el('p', { class: error ? 'error' : '' }, text),
    action && el('button', { class: 'btn', onclick: action.onClick }, action.label)
  ));
}

function showLoading() {
  refreshBtn.hidden = true;
  copyBtn.hidden = true;
  show(el('div', { class: 'center' },
    el('div', { class: 'spinner' }),
    el('p', {}, t('loading')),
    el('p', { style: 'font-size:12px' }, t('loadingHint'))
  ));
}

function scoreColor(s) {
  return s >= 70 ? 'var(--green)' : s >= 40 ? 'var(--amber)' : 'var(--red)';
}

// "3 days ago" / "לפני 3 ימים" in the UI language.
function relativeTime(date) {
  const rtf = new Intl.RelativeTimeFormat(LANGS[currentLang].locale, { numeric: 'auto' });
  const sec = (date.getTime() - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, s] of units) {
    if (Math.abs(sec) >= s) return rtf.format(Math.round(sec / s), unit);
  }
  return rtf.format(0, 'minute');
}

function formatDuration(total) {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

// Popularity 0-100, computed locally from public numbers (nothing to do with credibility):
//   reach      50%  total views on a log scale (100 views = 0, ~30M = 100)
//   engagement 25%  likes / views (4% or more = 100)
//   momentum   25%  views per day on a log scale (10/day = 0, 100K/day = 100)
// Missing inputs are dropped and the remaining weights are renormalized.
function popularityScore(stats, published) {
  if (!(stats.views > 0)) return null;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const parts = [{ w: 0.5, v: clamp01((Math.log10(stats.views) - 2) / 5.5) }];
  if (stats.likes != null) parts.push({ w: 0.25, v: clamp01(stats.likes / stats.views / 0.04) });
  if (published && !isNaN(published)) {
    const days = Math.max((Date.now() - published.getTime()) / 86400000, 1);
    parts.push({ w: 0.25, v: clamp01((Math.log10(stats.views / days) - 1) / 4) });
  }
  const totalWeight = parts.reduce((sum, p) => sum + p.w, 0);
  return Math.round(100 * parts.reduce((sum, p) => sum + p.w * p.v, 0) / totalWeight);
}

// Fills the popularity card: a score ring (like the credibility one, other color) with the
// video's numbers beside it. Missing values are simply left out.
function paintStats(box, stats, reason = '') {
  const unavailable = () => {
    box.className = 'stats';
    box.replaceChildren(...[
      el('div', {}, t('statsUnavailable')),
      reason && el('div', { class: 'reason', dir: 'ltr' }, reason)
    ].filter(Boolean));
  };
  if (!stats) return unavailable();

  const locale = LANGS[currentLang].locale;
  const num = (n) => new Intl.NumberFormat(locale).format(n);
  const line = (label, ...value) => el('div', { class: 'pop-line' }, el('b', {}, `${label}: `), ...value);

  const lines = [];
  const published = stats.publishDate ? new Date(stats.publishDate) : null;
  if (published && !isNaN(published)) {
    // Relative time first ("8 months ago"), the exact date after it in small, faded text.
    lines.push(line(t('statPublished'),
      relativeTime(published),
      ' ',
      el('span', { class: 'pop-date' }, `(${published.toLocaleDateString(locale, { dateStyle: 'medium' })})`)));
  }
  if (stats.views != null) lines.push(line(t('statViews'), num(stats.views)));
  if (stats.likes != null) lines.push(line(t('statLikes'), num(stats.likes)));
  if (stats.lengthSeconds) lines.push(line(t('statLength'), formatDuration(stats.lengthSeconds)));
  if (lines.length === 0) return unavailable();

  const popularity = popularityScore(stats, published);
  box.className = 'verdict-row pop-row';
  box.replaceChildren(...[
    popularity != null && el('div', { class: 'pop-box', title: t('popularityHint') },
      el('div', { class: 'score', style: `--p:${popularity};--sc:var(--blue)` }, el('span', {}, popularity)),
      el('div', { class: 'score-label' }, t('statPopularity'), el('span', { class: 'info' }, 'ⓘ'))),
    el('div', { class: 'pop-lines' }, lines)
  ].filter(Boolean));
}

// Cached analyses may be days old, so the numbers are refreshed from YouTube every time.
async function loadStats(box, cachedStats) {
  if (cachedStats) paintStats(box, cachedStats);
  const reasons = []; // shown (in English) only if no stats could be found at all
  let fresh = null;

  // 1) Read straight from the open video page.
  try {
    fresh = await readStatsFromTab(currentTab?.id, getVideoId(currentTab?.url || ''));
    if (!fresh) reasons.push('page: player not ready or shows another video');
  } catch (e) {
    reasons.push(`page: ${e.message}`);
  }

  // 2) Fall back to (or complete with) the background's watch-page fetch.
  if (!statsComplete(fresh)) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'stats', url: currentTab?.url });
      if (!resp?.ok) reasons.push('background: fetch failed (see the service worker console)');
      fresh = mergeStats(fresh, resp?.stats);
    } catch (e) {
      reasons.push(`background: ${e.message}`);
    }
  }

  if (!box.isConnected) return;
  if (fresh) paintStats(box, fresh);
  else if (!cachedStats) paintStats(box, null, reasons.join(' | '));
}

function renderResult({ videoId, meta, result, partial, ts }) {
  const catColor = CATEGORY_COLORS[result.category] || 'var(--gray)';
  const score = result.credibility_score;
  const statsBox = el('div', { class: 'stats' });
  loadStats(statsBox, meta.stats);

  const list = (items, cls) =>
    el('ul', { class: cls || '' }, (items || []).map((x) => el('li', {}, emphasize(x))));

  // Video titles may be in another script than the UI; let the browser pick their direction.
  // When the title was translated, clicking it toggles between the translation and the original.
  const translated = result.title_translated;
  const original = meta.title;
  // The translation is always in the UI language, so force the UI direction (a Hebrew title that starts
  // with a Latin word would otherwise be laid out LTR by dir="auto"). The original keeps dir="auto".
  const uiDir = LANGS[currentLang].dir;
  const titleEl = (translated || original) && el('p', {
    class: 'video-title',
    dir: translated ? uiDir : 'auto'
  }, translated || original);
  if (titleEl && translated && original && translated.trim() !== original.trim()) {
    let showingOriginal = false;
    const toggleTitle = () => {
      showingOriginal = !showingOriginal;
      titleEl.textContent = showingOriginal ? original : translated;
      titleEl.dir = showingOriginal ? 'auto' : uiDir;
      titleEl.title = t(showingOriginal ? 'titleShowTranslated' : 'titleShowOriginal');
    };
    titleEl.classList.add('toggleable');
    titleEl.title = t('titleShowOriginal');
    titleEl.setAttribute('role', 'button');
    titleEl.tabIndex = 0;
    titleEl.addEventListener('click', toggleTitle);
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTitle(); }
    });
  }

  show(
    el('div', { class: 'title-row' },
      el('img', {
        class: 'thumb',
        src: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        alt: '', width: 64, height: 36,
        onerror: (e) => e.target.remove() // offline etc.: no empty frame
      }),
      el('div', {},
        titleEl,
        meta.channel && el('div', { class: 'channel', dir: 'auto' },
          // Subscriber count comes from the stats saved with the analysis (it barely changes).
          meta.stats?.subscribers
            ? `${meta.channel} · ${meta.stats.subscribers} ${t('statSubs').toLowerCase()}`
            : meta.channel))
    ),

    result.ai_generated_suspected && el('div', { class: 'ai-banner', role: 'alert' },
      el('span', { class: 'ai-icon', 'aria-hidden': 'true' }, '🤖'),
      el('div', {},
        el('div', { class: 'ai-title' }, t('aiSuspectedTitle')),
        el('div', { class: 'ai-text' }, t('aiSuspected')))),

    el('div', { class: 'verdict-row', style: `--c:${catColor}` },
      el('div', {
        class: 'score-box',
        role: 'button',
        tabindex: '0',
        title: plain(result.score_explanation) || t('scoreHowHover'),
        onclick: toggleHow,
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleHow())
      },
        el('div', { class: 'score', style: `--p:${score};--sc:${scoreColor(score)}` }, el('span', {}, score)),
        el('div', { class: 'score-label' }, t('credibility'), el('span', { class: 'info' }, 'ⓘ'))
      ),
      el('div', {},
        el('span', { class: 'chip', style: `--c:${catColor}` }, t(`cat_${result.category}`)),
        el('p', { class: 'verdict' }, emphasize(result.verdict))
      )
    ),

    renderHow(result),

    statsBox,

    partial && el('div', { class: 'notice' }, t('partial')),
    el('section', {}, el('h2', {}, t('summary')), el('p', {}, emphasize(result.summary))),

    showDetails && result.key_points?.length > 0 &&
      el('section', {}, el('h2', {}, t('keyPoints')), list(result.key_points)),

    result.red_flags?.length > 0 &&
      el('section', {}, el('h2', {}, t('redFlags')), list(result.red_flags, 'flags')),

    el('div', { class: 'channel', style: 'margin-top:12px;font-size:11px' },
      t('analyzedAt', new Date(ts).toLocaleString(LANGS[currentLang].locale, { dateStyle: 'short', timeStyle: 'short' })))
  );
  refreshBtn.hidden = false;
  shareText = buildShareText(videoId, meta, result);
  copyBtn.hidden = false;
}

// WhatsApp formatting: *bold*. The AI's own *emphasis* is kept (and **double** becomes single).
function buildShareText(videoId, meta, result) {
  const title = (result.title_translated || meta.title || '').replace(/\*/g, '').trim();
  const url = isShortsUrl(currentTab?.url || '')
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
  // WhatsApp only bolds when the asterisk isn't glued to a letter: "ו*שילוב*" -> "ו-*שילוב*".
  const LETTER = /[\p{L}\p{N}]/u;
  const clean = (text) => String(text ?? '')
    .replace(/\*{2,}/g, '*')
    .replace(/\*([^*\n]+)\*/g, (m, inner, offset, whole) => {
      const before = whole[offset - 1];
      const after = whole[offset + m.length];
      return `${before && LETTER.test(before) ? '-' : ''}*${inner}*${after && LETTER.test(after) ? '-' : ''}`;
    })
    .trim();
  const summary = clean(result.summary);
  const bullets = (items) => items.map((s) => `• ${clean(s)}`);
  const section = (label, items) =>
    Array.isArray(items) && items.length > 0 ? ['', `*${label}:*`, ...bullets(items)] : [];
  return [
    `*${t('shareTitle')}:* ${title}`,
    `*${t('shareCategory')}:* ${t(`cat_${result.category}`)}`,
    `*${t('shareScore')}:* ${result.credibility_score}/100`,
    `*${t('summary')}:* ${summary}`,
    // Same optional sections the popup shows, in the same order.
    ...(showDetails ? section(t('keyPoints'), result.key_points) : []),
    ...section(t('redFlags'), result.red_flags),
    '',
    url
  ].join('\n');
}

// Collapsible "how was the score determined?" panel under the verdict row.
function renderHow(result) {
  const factors = Array.isArray(result.score_factors) ? result.score_factors : [];
  const hasInfo = result.score_explanation || factors.length > 0;
  return el('details', { class: 'how', id: 'how' },
    el('summary', {}, t('scoreHow')),
    hasInfo
      ? [
          result.score_explanation && el('p', {}, emphasize(result.score_explanation)),
          factors.length > 0 && el('ul', { class: 'factors' }, factors.map((f) =>
            el('li', { class: f.effect === 'negative' ? 'neg' : 'pos' }, emphasize(f.text))))
        ]
      : el('p', { class: 'muted' }, t('scoreHowOld'))
  );
}

function toggleHow() {
  const how = document.getElementById('how');
  if (!how) return;
  how.open = !how.open;
  if (how.open) how.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderError(resp) {
  const openSettings = { label: t('openSettings'), onClick: () => chrome.runtime.openOptionsPage() };
  switch (resp.code) {
    case 'NOT_YOUTUBE':
      return showMessage(t('notYoutube'));
    case 'NO_KEY':
      return showMessage(t('noKey'), { action: openSettings });
    case 'BAD_KEY':
    case 'BAD_MODEL':
      return showMessage(t(`err_${resp.code}`, resp.detail), { error: true, action: openSettings });
    default: {
      const known = STRINGS.en[`err_${resp.code}`];
      const text = known ? t(`err_${resp.code}`, resp.detail) : resp.detail || t('err_UNKNOWN');
      return showMessage(text, { error: true, action: { label: t('tryAgain'), onClick: () => run(true) } });
    }
  }
}

async function run(force = false) {
  if (!currentTab) {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!currentTab?.url) return renderError({ code: 'NOT_YOUTUBE' });

  showLoading();
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'analyze', tabId: currentTab.id, url: currentTab.url, lang: currentLang, force
    });
  } catch (e) {
    resp = { ok: false, detail: e.message };
  }
  if (resp?.ok) renderResult(resp.entry);
  else renderError(resp || {});
}

(async () => {
  const settings = await chrome.storage.local.get(DEFAULTS);
  showDetails = settings.showDetails;
  setLang(settings.language);
  fillLangSelect(langSelect);
  applyI18n();
  run();
})();
