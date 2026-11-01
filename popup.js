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

document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
refreshBtn.addEventListener('click', () => run(true));
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
  show(el('div', { class: 'center' },
    el('div', { class: 'spinner' }),
    el('p', {}, t('loading')),
    el('p', { style: 'font-size:12px' }, t('loadingHint'))
  ));
}

function scoreColor(s) {
  return s >= 70 ? 'var(--green)' : s >= 40 ? 'var(--amber)' : 'var(--red)';
}

function renderResult({ meta, result, partial, ts }) {
  const catColor = CATEGORY_COLORS[result.category] || 'var(--gray)';
  const score = result.credibility_score;

  const list = (items, cls) =>
    el('ul', { class: cls || '' }, (items || []).map((x) => el('li', {}, x)));

  // Video titles may be in another script than the UI; let the browser pick their direction.
  show(
    meta.title && el('p', { class: 'video-title', dir: 'auto' }, meta.title),
    meta.channel && el('div', { class: 'channel', dir: 'auto' }, meta.channel),

    el('div', { class: 'verdict-row', style: `--c:${catColor}` },
      el('div', {
        class: 'score-box',
        role: 'button',
        tabindex: '0',
        title: result.score_explanation || t('scoreHowHover'),
        onclick: toggleHow,
        onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleHow())
      },
        el('div', { class: 'score', style: `--p:${score};--sc:${scoreColor(score)}` }, el('span', {}, score)),
        el('div', { class: 'score-label' }, t('credibility'), el('span', { class: 'info' }, 'ⓘ'))
      ),
      el('div', {},
        el('span', { class: 'chip', style: `--c:${catColor}` }, t(`cat_${result.category}`)),
        el('p', { class: 'verdict' }, result.verdict)
      )
    ),

    renderHow(result),

    partial && el('div', { class: 'notice' }, t('partial')),
    result.ai_generated_suspected && el('div', { class: 'notice' }, t('aiSuspected')),

    el('section', {}, el('h2', {}, t('summary')), el('p', {}, result.summary)),

    result.key_points?.length > 0 &&
      el('section', {}, el('h2', {}, t('keyPoints')), list(result.key_points)),

    result.red_flags?.length > 0 &&
      el('section', {}, el('h2', {}, t('redFlags')), list(result.red_flags, 'flags')),

    el('div', { class: 'channel', style: 'margin-top:12px;font-size:11px' },
      t('analyzedAt', new Date(ts).toLocaleString(LANGS[currentLang].locale, { dateStyle: 'short', timeStyle: 'short' })))
  );
  refreshBtn.hidden = false;
}

// Collapsible "how was the score determined?" panel under the verdict row.
function renderHow(result) {
  const factors = Array.isArray(result.score_factors) ? result.score_factors : [];
  const hasInfo = result.score_explanation || factors.length > 0;
  return el('details', { class: 'how', id: 'how' },
    el('summary', {}, t('scoreHow')),
    hasInfo
      ? [
          result.score_explanation && el('p', {}, result.score_explanation),
          factors.length > 0 && el('ul', { class: 'factors' }, factors.map((f) =>
            el('li', { class: f.effect === 'negative' ? 'neg' : 'pos' }, f.text)))
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
  const { language } = await chrome.storage.local.get(DEFAULTS);
  setLang(language);
  fillLangSelect(langSelect);
  applyI18n();
  run();
})();
