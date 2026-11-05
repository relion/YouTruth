// YouTruth – service worker
// Watches YouTube navigation, asks Gemini to classify + summarize the video,
// caches the result per video ID + language and serves it to the popup.

importScripts('shared.js'); // LANGS, DEFAULTS

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const CACHE_MAX = 60;

const CATEGORIES = [
  'verified_news',     // חדשות מוסמכות
  'news_unverified',   // דיווח חדשותי לא מאומת
  'opinion',           // דעה / פרשנות
  'educational',       // חינוכי / הסברתי
  'entertainment',     // בידור
  'satire',            // סאטירה / הומור
  'promotional',       // שיווקי / פרסומי
  'misleading',        // מטעה / מניפולטיבי
  'fake'               // פייק / מידע כוזב
];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: CATEGORIES },
    credibility_score: { type: 'INTEGER', description: '0-100, how trustworthy the factual content is' },
    score_explanation: { type: 'STRING', description: '1-2 sentences: how the score was reached' },
    score_factors: {
      type: 'ARRAY',
      description: '2-5 concrete factors that raised or lowered the score',
      items: {
        type: 'OBJECT',
        properties: {
          effect: { type: 'STRING', enum: ['positive', 'negative'] },
          text: { type: 'STRING' }
        },
        required: ['effect', 'text']
      }
    },
    verdict: { type: 'STRING', description: 'One-sentence verdict' },
    summary: { type: 'STRING', description: 'Summary of the video, 3-6 sentences' },
    key_points: { type: 'ARRAY', items: { type: 'STRING' } },
    red_flags: { type: 'ARRAY', items: { type: 'STRING' } },
    ai_generated_suspected: { type: 'BOOLEAN' },
    title_translated: { type: 'STRING', description: 'The video title translated into the target language (unchanged if already in it)' }
  },
  required: ['category', 'credibility_score', 'score_explanation', 'score_factors', 'verdict', 'summary', 'key_points', 'red_flags', 'ai_generated_suspected', 'title_translated'],
  propertyOrdering: ['category', 'credibility_score', 'score_explanation', 'score_factors', 'verdict', 'summary', 'key_points', 'red_flags', 'ai_generated_suspected', 'title_translated']
};

const inflight = new Map(); // "videoId:lang" -> Promise

// ---------- helpers ----------

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

async function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

const cacheKey = (videoId, lang) => `${videoId}:${lang}`;

async function getCached(key) {
  const { cache = {} } = await chrome.storage.local.get('cache');
  return cache[key] || null;
}

async function putCached(key, entry) {
  const { cache = {} } = await chrome.storage.local.get('cache');
  cache[key] = entry;
  const ids = Object.keys(cache);
  if (ids.length > CACHE_MAX) {
    ids.sort((a, b) => cache[a].ts - cache[b].ts)
      .slice(0, ids.length - CACHE_MAX)
      .forEach((id) => delete cache[id]);
  }
  await chrome.storage.local.set({ cache });
}

// The popup translates `code`; `detail` is an untranslated parameter (model name, API message…).
class AppError extends Error {
  constructor(code, detail = '', status) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

// ---------- badge ----------

function setBadge(tabId, state, score) {
  if (tabId == null) return;
  const set = (text, color) => {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  };
  if (state === 'clear') return set('');
  if (state === 'loading') return set('…', '#757575');
  if (state === 'error') return set('!', '#9e9e9e');
  const color = score >= 70 ? '#2e7d32' : score >= 40 ? '#f9a825' : '#c62828';
  set(String(score), color);
}

// ---------- Gemini ----------

function buildPrompt(meta, withVideo, lang) {
  const today = new Date().toISOString().slice(0, 10);
  const language = LANGS[lang]?.promptName || 'English';
  return `You are YouTruth, a careful media-literacy analyst.
${withVideo ? 'Watch and listen to the attached YouTube video.' : 'The video itself could not be loaded; analyze ONLY from the metadata below and state clearly in the verdict that the analysis is partial.'}

Video metadata:
- URL: ${meta.url}
- Title: ${meta.title || 'unknown'}
- Channel: ${meta.channel || 'unknown'}
- Published: ${meta.stats?.publishDate || 'unknown'}

Tasks:
1. Classify the nature of the video into exactly one category:
   verified_news (established, accountable news outlet reporting verifiable facts),
   news_unverified (news-like reporting from an unknown/unaccountable source or unconfirmed claims),
   opinion (commentary, punditry, personal take), educational, entertainment, satire,
   promotional (ads, sponsored, selling something), misleading (manipulative editing, cherry-picking,
   clickbait that contradicts content, out-of-context footage), fake (fabricated events, debunked claims,
   impersonation, deepfakes presented as real).
2. Give credibility_score 0-100 for how trustworthy the video is about what it presents (not production quality).
   For satire, comedy, fiction or entertainment that is recognizable as such, judge honesty about its own nature:
   clearly-labeled satire scores high; satire easily mistaken for real news scores lower.
   Reserve very low scores for content that deceives viewers about facts.
   Explain the score: score_explanation (1-2 sentences, plain language) and score_factors (2-5 concrete items,
   each marked positive if it raised the score or negative if it lowered it, e.g. "cites official data on screen",
   "claim X contradicts published records"). Factors must follow the neutrality rules below.
3. List concrete red_flags (empty array if none) and key_points (3-6 items).
4. Set ai_generated_suspected=true only if there are visible/audible signs of synthetic media.
5. Write a summary of what the video says/shows.
6. Provide title_translated: the video title translated into ${language}. If the title is already in ${language},
   return it unchanged. Keep proper names (people, places, brands, channel names) as they are commonly written.

Rules:
- Today's date is ${today}. Events after your knowledge cutoff are NOT evidence of fabrication;
  if you cannot verify them, prefer news_unverified and say so, rather than fake.
- Be fair: do not label content fake merely because it is controversial or one-sided — use opinion for that.
- Political neutrality (critical): political views, ideology and policy positions — right-wing, left-wing,
  nationalist, religious, conservative, progressive or any other — are NOT a credibility factor.
  Do not lower the score because you or others disagree with a stance, or because it is considered
  hawkish, harsh, unpopular or "extreme". Policy proposals and value judgments (e.g. what a government
  should do) are neither true nor false and must not be scored as misinformation.
- For opinion/commentary, base credibility_score only on: (a) accuracy of verifiable factual claims made,
  (b) whether opinion is presented transparently as opinion rather than as fact. A clearly-presented
  opinion with no false factual claims should score high (70+), whatever its political direction.
- Apply exactly the same standard to every side of the political spectrum.
- Describe positions neutrally in the speaker's own terms; avoid loaded labels such as "extreme",
  "radical", "far-right" or "far-left" in verdict, summary and red_flags. Red flags must point to concrete
  factual errors or manipulation techniques, never to the political position itself.
- Write ALL free-text fields (verdict, summary, key_points, red_flags, score_explanation, score_factors) in ${language},
  regardless of the language spoken in the video.`;
}

async function callGemini({ apiKey, model }, parts, withVideo) {
  const generationConfig = {
    temperature: 0.2,
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA
  };
  // Low media resolution keeps token usage (and cost) of long videos down.
  if (withVideo) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';

  let res;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
    });
  } catch (e) {
    throw new AppError('NETWORK');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new AppError('QUOTA', '', 429);
    if (/API key/i.test(msg) || res.status === 401) throw new AppError('BAD_KEY', '', res.status);
    if (res.status === 404 && /models\//.test(msg)) throw new AppError('BAD_MODEL', model, 404);
    throw new AppError('API', msg, res.status);
  }

  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'UNKNOWN';
    throw new AppError('EMPTY', reason);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('PARSE');
  }
}

async function fetchMeta(videoId) {
  const url = watchUrl(videoId);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (r.ok) {
      const j = await r.json();
      return { url, title: j.title, channel: j.author_name, thumbnail: j.thumbnail_url };
    }
  } catch {}
  return { url };
}

// ---------- video stats (publish date, views, likes…) ----------
// Scraped from the public watch page – no extra API key needed. Best effort: any field may be null.

const STATS_TTL = 5 * 60 * 1000;
const statsCache = new Map(); // videoId -> { ts, promise }

// Pulls a JSON object assigned in an inline <script> (e.g. `ytInitialPlayerResponse = {...};`).
function extractJson(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, k + 1)); } catch { return null; }
    }
  }
  return null;
}

async function scrapeStats(videoId) {
  const res = await fetch(`${watchUrl(videoId)}&hl=en`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/consent\./.test(res.url)) throw new Error('consent redirect');
  const html = await res.text();

  const player = extractJson(html, 'ytInitialPlayerResponse');
  if (!player) throw new Error('no player data in page');
  const details = player.videoDetails || {};
  const micro = player.microformat?.playerMicroformatRenderer || {};

  const likes =
    toInt(micro.likeCount) ??
    toInt(html.match(/like this video along with ([\d,.\s]+) other people/)?.[1]) ??
    toInt(html.match(/"label":"([\d,]+) likes"/)?.[1]) ??
    toInt(html.match(/"likeCount":"?(\d+)"?/)?.[1]);

  const subscribers =
    html.match(/"subscriberCountText":\{.{0,300}?"simpleText":"([\d.,]+\s*[KMB]?)\s*subscribers?"/s)?.[1]?.trim() || null;

  return {
    publishDate: micro.publishDate || micro.uploadDate || null,
    views: toInt(details.viewCount) ?? toInt(micro.viewCount),
    likes,
    lengthSeconds: toInt(details.lengthSeconds) ?? toInt(micro.lengthSeconds),
    subscribers
  };
}

// Fallback source (cached for a few minutes); resolves to null on failure.
function fetchStats(videoId) {
  const hit = statsCache.get(videoId);
  if (hit && Date.now() - hit.ts < STATS_TTL) return hit.promise;
  const promise = scrapeStats(videoId).catch((e) => {
    console.warn('YouTruth: stats fetch failed', e);
    statsCache.delete(videoId);
    return null;
  });
  statsCache.set(videoId, { ts: Date.now(), promise });
  return promise;
}

// The open tab is the primary source (what the user actually sees); the watch-page fetch fills gaps.
async function getStats(tabId, videoId) {
  let fromTab = null;
  try {
    fromTab = await readStatsFromTab(tabId, videoId);
  } catch (e) {
    console.warn('YouTruth: reading stats from the tab failed', e);
  }
  return statsComplete(fromTab) ? fromTab : mergeStats(fromTab, await fetchStats(videoId));
}

async function runAnalysis(videoId, lang, tabId) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new AppError('NO_KEY');

  const [meta, stats] = await Promise.all([fetchMeta(videoId), getStats(tabId, videoId)]);
  meta.stats = stats; // kept in the cache as a fallback if the popup can't refresh it
  let result;
  let partial = false;
  try {
    result = await callGemini(settings, [
      { fileData: { fileUri: meta.url } },
      { text: buildPrompt(meta, true, lang) }
    ], true);
  } catch (e) {
    // Key / quota / model problems won't be fixed by retrying without the video.
    if (['NO_KEY', 'BAD_KEY', 'QUOTA', 'BAD_MODEL', 'NETWORK'].includes(e.code)) throw e;
    // Private, age-restricted, too long, live etc. → fall back to metadata only.
    console.warn('YouTruth: video analysis failed, falling back to metadata', e);
    result = await callGemini(settings, [{ text: buildPrompt(meta, false, lang) }], false);
    partial = true;
  }

  if (!CATEGORIES.includes(result.category)) result.category = 'news_unverified';
  result.credibility_score = Math.max(0, Math.min(100, Math.round(Number(result.credibility_score) || 0)));
  if (typeof result.title_translated !== 'string') result.title_translated = '';

  return { videoId, lang, meta, result, partial, model: settings.model, ts: Date.now() };
}

function analyze(videoId, lang, { force = false, tabId } = {}) {
  const key = cacheKey(videoId, lang);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    if (!force) {
      const cached = await getCached(key);
      if (cached) return cached;
    }
    const entry = await runAnalysis(videoId, lang, tabId);
    await putCached(key, entry);
    return entry;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function analyzeForTab(tabId, videoId, lang, opts) {
  setBadge(tabId, 'loading');
  try {
    const entry = await analyze(videoId, lang, { ...opts, tabId });
    setBadge(tabId, 'done', entry.result.credibility_score);
    return entry;
  } catch (e) {
    setBadge(tabId, e.code === 'NO_KEY' ? 'clear' : 'error');
    throw e;
  }
}

// ---------- events ----------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // YouTube is a SPA: pushState navigation also reports changeInfo.url.
  if (!changeInfo.url) return;
  const videoId = getVideoId(changeInfo.url);
  if (!videoId) return setBadge(tabId, 'clear');

  const { autoAnalyze, apiKey, language } = await getSettings();
  const cached = await getCached(cacheKey(videoId, language));
  if (cached) return setBadge(tabId, 'done', cached.result.credibility_score);

  if (autoAnalyze && apiKey) analyzeForTab(tabId, videoId, language).catch(() => {});
  else setBadge(tabId, 'clear');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'stats') {
    const id = getVideoId(msg.url || '');
    if (!id) { sendResponse({ ok: false }); return false; }
    fetchStats(id).then((stats) => sendResponse({ ok: !!stats, stats }));
    return true;
  }
  if (msg?.type !== 'analyze') return false;
  const videoId = getVideoId(msg.url || '');
  if (!videoId) {
    sendResponse({ ok: false, code: 'NOT_YOUTUBE' });
    return false;
  }
  getSettings()
    .then(({ language }) => analyzeForTab(msg.tabId, videoId, msg.lang || language, { force: !!msg.force }))
    .then((entry) => sendResponse({ ok: true, entry }))
    .catch((e) => sendResponse({ ok: false, code: e.code || 'UNKNOWN', detail: e.detail || e.message }));
  return true; // async response
});

// The toolbar icon is disabled (grayed out, popup won't open) everywhere except YouTube.
// Tab-specific ShowAction from the rule below overrides the global disabled state.
function setupActionVisibility() {
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [
        new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: 'youtube.com', schemes: ['https'] } }),
        new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: '.youtube.com', schemes: ['https'] } })
      ],
      actions: [new chrome.declarativeContent.ShowAction()]
    }]);
  });
}

chrome.runtime.onStartup.addListener(() => chrome.action.disable());

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setupActionVisibility();
  if (reason === 'install') {
    const { apiKey } = await getSettings();
    if (!apiKey) chrome.runtime.openOptionsPage();
  }
});
