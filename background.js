// YouTruth – service worker
// Watches YouTube navigation, asks Gemini to classify + summarize the video,
// caches the result per video ID + language and serves it to the popup.

importScripts('shared.js'); // LANGS, DEFAULTS, trimCache

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SHORT_VIDEO_SECONDS = 180; // clips up to this length are analyzed at higher visual detail

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
  const { cache = {}, cacheMax } = await chrome.storage.local.get({ cache: {}, cacheMax: DEFAULTS.cacheMax });
  cache[key] = entry;
  await chrome.storage.local.set({ cache: trimCache(cache, cacheMax) });
}

// The popup translates `code`; `detail` is an untranslated parameter (model name, API message…).
class AppError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- badge ----------

const DEBUG = false; // set to true to log every icon-state decision to the service worker console
const log = (...args) => { if (DEBUG) console.log('[YouTruth]', ...args); };

// While waiting/loading, the toolbar icon itself is redrawn: the logo with a small dark pill in its
// corner – an hourglass while waiting, three "scrolling" dots while Gemini works. (Badge text is too
// small and cramped for that: "…" renders as a dash.) Other states use the normal badge text.

const ICON_PATHS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const iconBitmaps = {};          // size -> ImageBitmap of the logo
const iconAnim = new Map();      // tabId -> { timer, token }
let iconToken = 0;

async function logoBitmap(size) {
  if (!iconBitmaps[size]) {
    const blob = await (await fetch(chrome.runtime.getURL(ICON_PATHS[size]))).blob();
    iconBitmaps[size] = await createImageBitmap(blob);
  }
  return iconBitmaps[size];
}

// kind: 'dots' (frame = which dot is lit) or 'hourglass'
async function drawIcon(size, kind, frame = 0) {
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  g.drawImage(await logoBitmap(size), 0, 0, size, size);

  const w = Math.round(size * 0.8), h = Math.round(size * 0.46);
  const x = size - w, y = size - h, r = h / 2;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = '#2b2b2b';
  g.fill();
  g.lineWidth = Math.max(1, size / 16);
  g.strokeStyle = '#ffffff';
  g.stroke();

  if (kind === 'dots') {
    for (let i = 0; i < 3; i++) {
      const lit = i === frame;
      g.beginPath();
      g.arc(x + w * (0.25 + i * 0.25), y + h / 2, size * (lit ? 0.095 : 0.065), 0, Math.PI * 2);
      g.fillStyle = lit ? '#ffffff' : '#8a8a8a';
      g.fill();
    }
  } else if (kind === 'question') {
    // "?" = not analyzed automatically; click the icon to analyze
    g.fillStyle = '#ffffff';
    g.font = `bold ${Math.round(h * 0.95)}px Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('?', x + w / 2, y + h / 2 + size * 0.02);
  } else {
    // hourglass: two triangles meeting in the middle
    const cx = x + w / 2, cy = y + h / 2, hw = h * 0.28, hh = h * 0.34;
    g.beginPath();
    g.moveTo(cx - hw, cy - hh); g.lineTo(cx + hw, cy - hh); g.lineTo(cx, cy);
    g.moveTo(cx - hw, cy + hh); g.lineTo(cx + hw, cy + hh); g.lineTo(cx, cy);
    g.fillStyle = '#ffffff';
    g.fill();
  }
  return g.getImageData(0, 0, size, size);
}

function stopIconAnim(tabId) {
  const a = iconAnim.get(tabId);
  if (a) clearInterval(a.timer);
  iconAnim.delete(tabId);
}

async function paintIcon(tabId, anim) {
  const { kind, frame, token } = anim;
  const imageData = { 16: await drawIcon(16, kind, frame), 32: await drawIcon(32, kind, frame) };
  // Drop the result if the state changed (or another animation started) while drawing.
  if (iconAnim.get(tabId)?.token !== token) return;
  chrome.action.setIcon({ tabId, imageData }).catch(() => {});
}

// Repaints every 350 ms. Besides animating the dots, this also puts the icon back by itself if
// Chrome resets the tab's icon during a page navigation.
function startIconAnim(tabId, kind) {
  stopIconAnim(tabId);
  const anim = { kind, frame: 0, token: ++iconToken, timer: null };
  iconAnim.set(tabId, anim);
  paintIcon(tabId, anim).catch(() => {});
  if (kind === 'question') return; // static: painted once (and again on tab events), no timer
  anim.timer = setInterval(() => {
    if (kind === 'dots') anim.frame = (anim.frame + 1) % 3;
    paintIcon(tabId, anim).catch(() => {});
  }, 350);
}

// tabId -> { state, score }: the single source of truth for what a tab's icon should show.
// Chrome clears per-tab icon/badge values when a page navigates, so the state is re-applied
// from here on tab events (see the listeners in "events").
const tabState = new Map();

function applyState(tabId) {
  const { state, score } = tabState.get(tabId) || { state: 'clear' };
  const set = (text, color) => {
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  };

  if (state === 'loading' || state === 'waiting' || state === 'manual') {
    set('');
    const kind = state === 'loading' ? 'dots' : state === 'waiting' ? 'hourglass' : 'question';
    const running = iconAnim.get(tabId);
    if (running?.kind === kind) paintIcon(tabId, running).catch(() => {}); // repaint right away
    else startIconAnim(tabId, kind);
    return;
  }

  // Back to the normal logo.
  if (iconAnim.has(tabId)) {
    stopIconAnim(tabId);
    chrome.action.setIcon({ tabId, path: ICON_PATHS }).catch(() => {});
  }
  if (state === 'error') return set('!', '#9e9e9e');
  if (state === 'done') return set(String(score), score >= 70 ? '#2e7d32' : score >= 40 ? '#f9a825' : '#c62828');
  set('');
}

function setBadge(tabId, state, score) {
  if (tabId == null) return;
  log(`tab ${tabId}: ${state}${score != null ? ' ' + score : ''}`);
  tabState.set(tabId, { state, score });
  applyState(tabId);
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
4. Set ai_generated_suspected=true if the video is LIKELY fully or partly AI-generated or AI-edited
   (you do not need certainty; judge by the balance of evidence). Look closely at the footage for:
   - overly smooth, glossy, "too perfect" or dreamlike look; plastic-looking skin; unnatural lighting;
   - motion/physics glitches: morphing or melting shapes, objects or limbs that change between frames,
     impossible movement, water/fabric/hair behaving oddly, inconsistent shadows and reflections;
   - distorted hands, fingers, teeth, eyes, faces; text, signs or logos that are garbled or change;
   - very short clips (a few seconds) stitched together, repetitive looping motion, generic stock-like scenes;
   - synthetic or mismatched voice, lip-sync that is slightly off, generic AI music or narration;
   - a channel that posts many similar clips, or a topic/scene that looks implausible as real filming.
   Set it to false only when the footage looks like ordinary real filming and none of these signs appear.
   If you set it to true, add a short red_flag naming the concrete signs you saw.
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
- Emphasis: in summary, key_points, red_flags, verdict, score_explanation and score_factors, wrap the
  1-3 most important words or phrases of each sentence in single asterisks, like *this*. Use asterisks
  only for emphasis, never for anything else, and never nest them.
- Write ALL free-text fields (verdict, summary, key_points, red_flags, score_explanation, score_factors) in ${language},
  regardless of the language spoken in the video.`;
}

async function callGemini({ apiKey, model }, parts, withVideo, lengthSeconds) {
  const generationConfig = {
    temperature: 0.2,
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA
  };
  // Low media resolution keeps token usage (and cost) of long videos down, but it blurs the fine
  // details that give AI-generated footage away. Short clips (Shorts etc.) are cheap, so use more detail.
  if (withVideo) {
    const short = lengthSeconds > 0 && lengthSeconds <= SHORT_VIDEO_SECONDS;
    generationConfig.mediaResolution = short ? 'MEDIA_RESOLUTION_MEDIUM' : 'MEDIA_RESOLUTION_LOW';
  }

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
    if (res.status === 429) throw new AppError('QUOTA');
    if (/API key/i.test(msg) || res.status === 401) throw new AppError('BAD_KEY');
    if (res.status === 404 && /models\//.test(msg)) throw new AppError('BAD_MODEL', model);
    throw new AppError('API', msg);
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
      return { url, title: j.title, channel: j.author_name };
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
    ], true, stats?.lengthSeconds);
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

// The video each tab currently shows. An analysis that finishes after the viewer moved on must not
// paint its result onto the new video's icon.
const tabVideo = new Map();
const isCurrent = (tabId, videoId) => !tabVideo.has(tabId) || tabVideo.get(tabId) === videoId;

async function analyzeForTab(tabId, videoId, lang, opts) {
  if (isCurrent(tabId, videoId)) setBadge(tabId, 'loading');
  try {
    const entry = await analyze(videoId, lang, { ...opts, tabId });
    if (isCurrent(tabId, videoId)) setBadge(tabId, 'done', entry.result.credibility_score);
    return entry;
  } catch (e) {
    if (isCurrent(tabId, videoId)) setBadge(tabId, e.code === 'NO_KEY' ? 'clear' : 'error');
    throw e;
  }
}

// ---------- events ----------

// Shorts are scrolled through quickly, so a Short is analyzed only after the viewer has stayed on it
// for `shortsDelay` seconds (0 = no waiting). tabId -> { videoId, timer }
const pendingShorts = new Map();
const latestUrl = new Map(); // tabId -> last URL seen (to drop stale async handlers)

function cancelPending(tabId) {
  const p = pendingShorts.get(tabId);
  if (p) { clearTimeout(p.timer); pendingShorts.delete(tabId); }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelPending(tabId);
  stopIconAnim(tabId);
  tabState.delete(tabId);
  latestUrl.delete(tabId);
  tabVideo.delete(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Chrome wipes a tab's icon/badge when its page navigates (also on reload, which reports no URL
  // change). Paint the remembered state again as the load progresses and once it is done.
  if (changeInfo.status && tabState.has(tabId)) {
    log(`tab ${tabId}: status ${changeInfo.status} -> re-apply ${tabState.get(tabId).state}`);
    applyState(tabId);
    if (changeInfo.status === 'complete') setTimeout(() => tabState.has(tabId) && applyState(tabId), 800);
  }

  // YouTube is a SPA: pushState navigation also reports changeInfo.url.
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  const videoId = getVideoId(url);
  log(`tab ${tabId}: url ${url} (video ${videoId || 'none'})`);

  // The same video reported again (e.g. SPA + full load events): nothing new to decide.
  if (videoId && tabVideo.get(tabId) === videoId && latestUrl.get(tabId) === url) {
    if (tabState.has(tabId)) applyState(tabId);
    return;
  }
  latestUrl.set(tabId, url);
  if (videoId) tabVideo.set(tabId, videoId); else tabVideo.delete(tabId);

  cancelPending(tabId); // the viewer moved on
  setBadge(tabId, 'clear'); // drop the previous video's state at once
  if (!videoId) return;
  await decideAnalysis(tabId, url, videoId);
});

// What to do for the video a tab shows: show a saved result, analyze now, wait first (Shorts), or
// leave it to the user ("?" on the icon).
async function decideAnalysis(tabId, url, videoId) {
  const { autoAnalyze, shortsDelay, apiKey, language } = await getSettings();
  if (latestUrl.get(tabId) !== url) return; // navigated again while reading the settings

  const cached = await getCached(cacheKey(videoId, language));
  if (latestUrl.get(tabId) !== url) return;
  if (cached) return setBadge(tabId, 'done', cached.result.credibility_score);

  // Already being analyzed (e.g. the viewer scrolled away and came back): no waiting needed, just
  // show the progress again. analyze() joins the running request, so nothing is sent twice.
  if (inflight.has(cacheKey(videoId, language))) {
    log(`tab ${tabId}: analysis already running, joining it`);
    analyzeForTab(tabId, videoId, language).catch(() => {});
    return;
  }

  if (!apiKey) return log(`tab ${tabId}: no API key`); // icon stays plain; the popup guides to settings
  if (!autoAnalyze) { log(`tab ${tabId}: auto-analyze is off`); return setBadge(tabId, 'manual'); }

  const delay = Math.max(0, Number(shortsDelay) || 0);
  if (!isShortsUrl(url) || delay === 0) {
    analyzeForTab(tabId, videoId, language).catch(() => {});
    return;
  }

  // A Short: wait `delay` seconds on the same one first (hourglass on the icon).
  cancelPending(tabId);
  setBadge(tabId, 'waiting');
  const timer = setTimeout(async () => {
    pendingShorts.delete(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null); // null = the tab was closed
    if (!tab || getVideoId(tab.url || '') !== videoId) return;  // closed, or the viewer moved on
    if (!tab.active) return setBadge(tabId, 'manual');          // hidden tab: don't spend a request
    analyzeForTab(tabId, videoId, language).catch(() => {});
  }, delay * 1000);
  pendingShorts.set(tabId, { videoId, timer });
}

// Switching tabs: repaint that tab's icon, and if its Short was skipped because the tab was hidden,
// decide again now.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!tabState.has(tabId)) return;
  applyState(tabId);
  if (tabState.get(tabId).state !== 'manual') return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const videoId = getVideoId(tab?.url || '');
  if (!videoId || !isShortsUrl(tab.url) || pendingShorts.has(tabId)) return;
  latestUrl.set(tabId, tab.url);
  await decideAnalysis(tabId, tab.url, videoId);
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
  if (msg.tabId != null) {
    tabVideo.set(msg.tabId, videoId); // the popup shows this tab's current video
    cancelPending(msg.tabId);         // the user asked for it: no need to wait out the Short delay
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
