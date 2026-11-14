// YouTruth – shared settings + UI strings (loaded by popup, options and the service worker).

const LANGS = {
  he: { name: 'עברית',   dir: 'rtl', locale: 'he-IL', promptName: 'Hebrew' },
  ro: { name: 'Română',  dir: 'ltr', locale: 'ro-RO', promptName: 'Romanian' },
  en: { name: 'English', dir: 'ltr', locale: 'en-US', promptName: 'English' }
};

function detectLang() {
  const l = (self.navigator?.language || 'en').slice(0, 2).toLowerCase();
  return l === 'iw' ? 'he' : LANGS[l] ? l : 'en';
}

const DEFAULTS = { apiKey: '', model: 'gemini-3.5-flash-lite', autoAnalyze: true, shortsDelay: 4, showDetails: true, cacheMax: 60, longVideoFps: 1, agentic: false, language: detectLang() };

// Videos longer than this count as "long": they can be sampled at a lower frame rate, or analyzed agentically.
const LONG_VIDEO_SECONDS = 300;
const FPS_CHOICES = [1, 0.5, 0.25]; // frames per second sent to Gemini for long videos (1 = Gemini's default)
// Models offered in the settings, with their paid-tier price in USD per 1M tokens (output includes thinking
// tokens). Each model has price tiers by start date, so a scheduled price change is encoded here once.
// Source: https://aistudio.google.com/docs/pricing (checked Nov 2026) – update when Google changes prices.
const MODEL_PRICES = {
  'gemini-3.5-flash-lite': [{ from: '2000-01-01', input: 0.30, output: 2.50 }],
  'gemini-3.8-flash': [
    { from: '2000-01-01', input: 0.75, output: 3.75 },
    { from: '2027-01-01', input: 1.50, output: 7.50 }
  ]
};
const MODEL_CHOICES = Object.keys(MODEL_PRICES);

// A saved model that is no longer offered (e.g. an older default or a hand-typed name) falls back to the default.
const normalizeModel = (m) => (MODEL_CHOICES.includes(m) ? m : DEFAULTS.model);

// Price tier in effect on `date`, or null for an unknown model.
function priceFor(model, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const tiers = MODEL_PRICES[model];
  return tiers ? tiers.filter((p) => p.from <= day).pop() : null;
}
const CACHE_MIN = 10;
const CACHE_LIMIT = 300; // upper bound for the "saved analyses" setting (keeps chrome.storage.local small)

// Keeps only the newest `max` entries of the analysis cache (mutates and returns it).
function trimCache(cache, max) {
  const ids = Object.keys(cache);
  if (ids.length > max) {
    ids.sort((a, b) => cache[a].ts - cache[b].ts)
      .slice(0, ids.length - max)
      .forEach((id) => delete cache[id]);
  }
  return cache;
}

// Token-usage buckets are kept per calendar month ("2026-11") in chrome.storage.local → usage.months.
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const STRINGS = {
  he: {
    close: 'סגור',
    copy: 'העתק',
    copied: 'הועתק ✓',
    shareTitle: 'ניתוח הסרטון',
    shareCategory: 'נושא/קטגוריה',
    shareScore: 'מדד אמינות',
    shareFooter: 'הפיענוח נעשה על ידי ג׳מיני (Gemini)',
    reanalyze: '↻ נתח מחדש',
    disclaimer: 'ניתוח אוטומטי של AI – עלול לטעות',
    loading: 'Gemini צופה בסרטון ומנתח אותו…',
    loadingHint: 'זה עשוי לקחת עד דקה. אפשר לסגור את החלון – התוצאה תישמר.',
    credibility: 'אמינות',
    scoreHow: 'איך נקבע הציון?',
    scoreHowHover: 'לחץ כדי לראות איך נקבע הציון',
    titleShowOriginal: 'לחץ להצגת הכותרת המקורית',
    titleShowTranslated: 'לחץ להצגת התרגום',
    scoreHowOld: 'הסבר הציון לא זמין לניתוח זה (נשמר בגרסה קודמת). לחץ "נתח מחדש" כדי לקבל אותו.',
    partial: 'לא ניתן היה לצפות בסרטון עצמו (פרטי, מוגבל גיל, שידור חי או ארוך מדי). הניתוח מבוסס על הכותרת והערוץ בלבד.',
    aiSuspectedTitle: 'נוצר באמצעות AI',
    aiSuspected: 'יש סימנים שהסרטון נוצר או נערך ב-AI.',
    summary: 'תקציר',
    keyPoints: 'נקודות עיקריות',
    redFlags: 'דגלים אדומים',
    analyzedAt: 'נותח ב-{0}',
    statPublished: 'פורסם',
    statViews: 'צפיות',
    statLikes: 'לייקים',
    statLength: 'אורך',
    statSubs: 'מנויים',
    statPopularity: 'פופולריות',
    popularityHint: 'ציון פופולריות (0–100) שמחושב מקומית: היקף צפיות (50%), יחס לייקים לצפיות (25%) וצפיות ליום (25%). לא קשור לאמינות.',
    statsUnavailable: 'פרטי הסרטון (תאריך, צפיות, לייקים) לא זמינים כרגע',
    notYoutube: 'פתח סרטון ב-YouTube ולחץ שוב על האייקון כדי לקבל ניתוח.',
    noKey: 'כדי להתחיל, הגדר מפתח API של Google AI Studio.',
    openSettings: 'פתח הגדרות',
    tryAgain: 'נסה שוב',
    err_UNKNOWN: 'אירעה שגיאה לא צפויה',
    err_NETWORK: 'אין חיבור לשרת של Gemini',
    err_QUOTA: 'חרגת ממכסת הבקשות של Gemini. נסה שוב מאוחר יותר.',
    err_BAD_KEY: 'מפתח ה-API אינו תקין',
    err_BAD_MODEL: 'המודל "{0}" לא נמצא. שנה אותו בהגדרות.',
    err_EMPTY: 'Gemini לא החזיר תשובה ({0})',
    err_PARSE: 'תשובת Gemini לא הייתה בפורמט תקין',
    err_API: 'שגיאת Gemini: {0}',
    cat_verified_news: 'חדשות מוסמכות',
    cat_news_unverified: 'דיווח לא מאומת',
    cat_opinion: 'דעה / פרשנות',
    cat_educational: 'חינוכי / הסברתי',
    cat_entertainment: 'בידור',
    cat_satire: 'סאטירה / הומור',
    cat_promotional: 'שיווקי / פרסומי',
    cat_misleading: 'מטעה / מניפולטיבי',
    cat_fake: 'פייק / מידע כוזב',
    optTitle: 'YouTruth – הגדרות',
    languageLabel: 'שפה',
    languageHint: 'שפת הממשק ושפת הניתוח שמחזיר Gemini.',
    apiKeyLabel: 'מפתח Gemini API',
    show: 'הצג',
    hide: 'הסתר',
    apiKeyHint: 'צור מפתח ב-<a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener">Google AI Studio</a>. המפתח נשמר מקומית בדפדפן בלבד ונשלח רק לשרתי Google.',
    modelLabel: 'מודל',
    modelHint: 'ברירת מחדל: gemini-3.5-flash-lite. "בדוק מפתח" יבדוק שהמפתח תקין ושהמודל שנבחר זמין לחשבון שלך.',
    usageLabel: 'שימוש בטוקנים (במכשיר הזה)',
    usageHint: 'סופר את הבקשות שהתוסף שלח ל-Gemini, את הטוקנים שלהן ועלות משוערת לפי התעריף בתשלום של המודל (בשכבה החינמית אין חיוב בפועל). הנתונים נשמרים רק במכשיר הזה והם הערכה לפי מה ש-Gemini מחזיר. החיוב בפועל מופיע ב-AI Studio.',
    usageTotal: 'סה"כ מאז {0}: {1} בקשות · קלט {2} · פלט {3} טוקנים · עלות משוערת {4}',
    usageNone: 'עדיין אין נתונים. הם יופיעו אחרי הניתוח הראשון.',
    usageReset: 'אפס מונה',
    usageResetConfirm: 'לאפס את מונה הטוקנים?',
    usageResetDone: 'המונה אופס',
    pricingLink: 'מחירון Gemini API ↗',
    modelDescLite: 'זול ומהיר, מתאים לשימוש יומיומי ולהרבה ניתוחים.',
    modelDescFlash: 'המודל החכם ביותר במשפחת Flash, אבל יקר יותר.',
    modelPrice: 'מחיר בתשלום: ${0} קלט / ${1} פלט למיליון טוקנים.',
    modelPriceFrom: 'מ-{0}: ${1} / ${2}.',
    autoLabel: 'נתח אוטומטית כל סרטון שנפתח',
    autoHint: 'כשמופעל, הניתוח מתחיל ברגע שנכנסים לסרטון והציון מופיע על האייקון. כשכבוי, הניתוח מתבצע רק בלחיצה על האייקון (חוסך במכסת הבקשות).',
    shortsDelayLabel: 'השהיה לפני ניתוח Short (בשניות)',
    shortsDelayHint: 'ב-Shorts הניתוח מתחיל רק אחרי שנשארים על אותו Short מספר שניות (⏳ על האייקון), כדי לא לבזבז בקשות על סרטונים שרק גוללים דרכם. אם הערך הוא 0 – אין המתנה והניתוח מתחיל מיד. חל רק כשהניתוח האוטומטי מופעל.',
    detailsLabel: 'הצג פרטים',
    detailsHint: 'כשמסומן, הפופאפ מציג גם את הנקודות העיקריות של הסרטון. כשלא מסומן, הן אינן מוצגות.',
    save: 'שמור',
    test: 'בדוק מפתח',
    clearCache: 'נקה תוצאות שמורות',
    billing: 'חיוב ושימוש ב-AI Studio ↗',
    saved: 'נשמר ✓',
    enterKeyFirst: 'הזן מפתח קודם',
    checking: 'בודק…',
    keyOkModel: 'המפתח תקין ✓ (המודל {0} זמין)',
    keyOkNoModel: 'המפתח תקין, אך המודל "{0}" לא נמצא ברשימה',
    errorPrefix: 'שגיאה: {0}',
    cacheCleared: 'התוצאות השמורות נמחקו',
    fpsLabel: 'קצב דגימת פריימים בסרטונים ארוכים',
    fpsHint: 'חל על סרטונים ארוכים מ-{0} דקות. קצב נמוך יותר שולח ל-Gemini פחות פריימים ולכן עולה פחות, אבל עלול לפספס שינויים חזותיים מהירים. הקול נשאר מלא. בסרטונים קצרים תמיד נשלח הקצב המלא. אם Gemini דוחה את ההגדרה, התוסף חוזר אוטומטית לקצב המלא.',
    fpsOpt1: '1 לשנייה – דגימה מלאה (ברירת מחדל)',
    fpsOpt05: '0.5 לשנייה – חוסך בערך 34% מהקלט',
    fpsOpt025: '0.25 לשנייה – חוסך בערך 50% מהקלט',
    agenticLabel: 'ניתוח "אג׳נטי" בסרטונים ארוכים (ניסיוני)',
    agenticHint: 'המודל מחליט בעצמו אילו קטעים בסרטון לצפות בהם, במקום לקבל את כולו, וזה יכול לחסוך עד 88% מהטוקנים. חל רק על סרטונים ארוכים מ-{0} דקות ובמודלים שתומכים בכך. התכונה חדשה ולפעמים נכשלת; אז התוסף חוזר אוטומטית לניתוח הרגיל ולא ינסה שוב במשך 24 שעות. כשהיא פעילה, היא גוברת על קצב הדגימה.',
    cacheMaxLabel: 'מספר ניתוחים לשמירה',
    cacheMaxHint: 'כך נחסכות בקשות כשחוזרים לסרטון שכבר נותח. כשמגיעים למספר הזה, הניתוחים הישנים ביותר נמחקים. אפשר בין {0} ל-{1}. הקטנת המספר מוחקת מיד את העודף.',
    cacheInfo: 'ניתוחים שמורים כעת: {0} מתוך {1}'
  },

  ro: {
    close: 'Închide',
    copy: 'Copiază',
    copied: 'Copiat ✓',
    shareTitle: 'Analiza videoclipului',
    shareCategory: 'Subiect/categorie',
    shareScore: 'Scor de credibilitate',
    shareFooter: 'Analiza a fost făcută de Gemini',
    reanalyze: '↻ Analizează din nou',
    disclaimer: 'Analiză automată AI – poate greși',
    loading: 'Gemini vizionează și analizează videoclipul…',
    loadingHint: 'Poate dura până la un minut. Puteți închide fereastra – rezultatul va fi salvat.',
    credibility: 'Credibilitate',
    scoreHow: 'Cum a fost stabilit scorul?',
    scoreHowHover: 'Apăsați pentru a vedea cum a fost stabilit scorul',
    titleShowOriginal: 'Apăsați pentru a vedea titlul original',
    titleShowTranslated: 'Apăsați pentru a vedea traducerea',
    scoreHowOld: 'Explicația scorului nu este disponibilă pentru această analiză (salvată de o versiune anterioară). Apăsați „Analizează din nou” pentru a o obține.',
    partial: 'Videoclipul nu a putut fi vizionat (privat, cu restricție de vârstă, live sau prea lung). Analiza se bazează doar pe titlu și canal.',
    aiSuspectedTitle: 'Creat cu AI',
    aiSuspected: 'Semne că videoclipul e generat sau editat cu AI.',
    summary: 'Rezumat',
    keyPoints: 'Puncte cheie',
    redFlags: 'Semne de alarmă',
    analyzedAt: 'Analizat la {0}',
    statPublished: 'Publicat',
    statViews: 'Vizionări',
    statLikes: 'Like-uri',
    statLength: 'Durată',
    statSubs: 'Abonați',
    statPopularity: 'Popularitate',
    popularityHint: 'Scor de popularitate (0–100) calculat local: numărul de vizionări (50%), raportul like-uri/vizionări (25%) și vizionări pe zi (25%). Nu are legătură cu credibilitatea.',
    statsUnavailable: 'Detaliile videoclipului (dată, vizionări, like-uri) nu sunt disponibile momentan',
    notYoutube: 'Deschideți un videoclip pe YouTube și apăsați din nou pe iconiță pentru analiză.',
    noKey: 'Pentru a începe, configurați o cheie API Google AI Studio.',
    openSettings: 'Deschide setările',
    tryAgain: 'Încearcă din nou',
    err_UNKNOWN: 'A apărut o eroare neașteptată',
    err_NETWORK: 'Nu există conexiune la serverul Gemini',
    err_QUOTA: 'Ați folosit toate cererile permise de Gemini. Încercați mai târziu.',
    err_BAD_KEY: 'Cheia API nu este validă',
    err_BAD_MODEL: 'Modelul „{0}” nu a fost găsit. Schimbați-l în setări.',
    err_EMPTY: 'Gemini nu a returnat un răspuns ({0})',
    err_PARSE: 'Răspunsul de la Gemini nu a fost în formatul corect',
    err_API: 'Eroare Gemini: {0}',
    cat_verified_news: 'Știri verificate',
    cat_news_unverified: 'Știre neverificată',
    cat_opinion: 'Părere / opinie',
    cat_educational: 'Educativ / explicativ',
    cat_entertainment: 'Amuzament',
    cat_satire: 'Umor / satiră',
    cat_promotional: 'Reclamă',
    cat_misleading: 'Înșelător',
    cat_fake: 'Fals / informații false',
    optTitle: 'YouTruth – Setări',
    languageLabel: 'Limbă',
    languageHint: 'Limba interfeței și a analizei returnate de Gemini.',
    apiKeyLabel: 'Cheie Gemini API',
    show: 'Arată',
    hide: 'Ascunde',
    apiKeyHint: 'Creați o cheie în <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener">Google AI Studio</a>. Cheia este salvată doar local în browser și trimisă numai către serverele Google.',
    modelLabel: 'Model',
    modelHint: 'Implicit: gemini-3.5-flash-lite. „Verifică cheia” verifică dacă cheia este validă și dacă modelul ales este disponibil pentru contul dvs.',
    usageLabel: 'Utilizare tokeni (pe acest dispozitiv)',
    usageHint: 'Numără cererile trimise de extensie către Gemini, tokenii lor și un cost estimat după tariful cu plată al modelului (în varianta gratuită nu se facturează nimic). Datele rămân doar pe acest dispozitiv și sunt o estimare după ce returnează Gemini. Facturarea reală apare în AI Studio.',
    usageTotal: 'Total din {0}: {1} cereri · intrare {2} · ieșire {3} tokeni · cost estimat {4}',
    usageNone: 'Încă nu există date. Vor apărea după prima analiză.',
    usageReset: 'Resetează contorul',
    usageResetConfirm: 'Resetați contorul de tokeni?',
    usageResetDone: 'Contorul a fost resetat',
    pricingLink: 'Prețurile Gemini API ↗',
    modelDescLite: 'Ieftin și rapid, potrivit pentru folosirea zilnică și pentru multe analize.',
    modelDescFlash: 'Cel mai inteligent model din familia Flash, dar mai scump.',
    modelPrice: 'Preț cu plată: ${0} intrare / ${1} ieșire la un milion de tokeni.',
    modelPriceFrom: 'Din {0}: ${1} / ${2}.',
    autoLabel: 'Analizează automat fiecare videoclip deschis',
    autoHint: 'Când este activat, analiza pornește imediat ce deschideți un videoclip, iar scorul apare pe pictogramă. Când este dezactivat, analiza rulează doar la clic pe pictogramă (economisește cota).',
    shortsDelayLabel: 'Așteptare înainte de analiza unui Short (secunde)',
    shortsDelayHint: 'La Shorts, analiza începe doar după ce rămâneți câteva secunde pe același Short (⏳ pe iconiță), ca să nu se consume cereri pentru videoclipuri pe lângă care doar derulați. Dacă valoarea este 0, nu se așteaptă și analiza începe imediat. Se aplică doar când analiza automată este activată.',
    detailsLabel: 'Afișează detalii',
    detailsHint: 'Când este bifat, fereastra afișează și punctele cheie ale videoclipului. Când nu este bifat, acestea nu sunt afișate.',
    save: 'Salvează',
    test: 'Verifică cheia',
    clearCache: 'Șterge rezultatele salvate',
    billing: 'Facturare și utilizare în AI Studio ↗',
    saved: 'Salvat ✓',
    enterKeyFirst: 'Introduceți mai întâi o cheie',
    checking: 'Se verifică…',
    keyOkModel: 'Cheia este validă ✓ (modelul {0} este disponibil)',
    keyOkNoModel: 'Cheia este validă, dar modelul „{0}” nu apare în listă',
    errorPrefix: 'Eroare: {0}',
    cacheCleared: 'Rezultatele salvate au fost șterse',
    fpsLabel: 'Frecvența de eșantionare a cadrelor la videoclipurile lungi',
    fpsHint: 'Se aplică videoclipurilor mai lungi de {0} minute. O frecvență mai mică trimite mai puține cadre către Gemini și costă mai puțin, dar poate rata schimbări vizuale rapide. Sunetul rămâne complet. La videoclipurile scurte se trimite mereu frecvența completă. Dacă Gemini refuză setarea, extensia revine automat la frecvența completă.',
    fpsOpt1: '1 pe secundă – eșantionare completă (implicit)',
    fpsOpt05: '0,5 pe secundă – economisește cam 34% din intrare',
    fpsOpt025: '0,25 pe secundă – economisește cam 50% din intrare',
    agenticLabel: 'Analiză „agentică” la videoclipurile lungi (experimental)',
    agenticHint: 'Modelul alege singur ce părți din videoclip să urmărească, în loc să primească tot videoclipul, ceea ce poate economisi până la 88% din tokeni. Se aplică doar videoclipurilor mai lungi de {0} minute și modelelor care o suportă. Funcția este nouă și uneori eșuează; atunci extensia revine automat la analiza obișnuită și nu mai încearcă 24 de ore. Dacă este activă, are prioritate față de frecvența de eșantionare.',
    cacheMaxLabel: 'Câte analize se păstrează',
    cacheMaxHint: 'Așa se economisesc cereri când reveniți la un videoclip deja analizat. Când se atinge acest număr, cele mai vechi analize se șterg. Puteți alege între {0} și {1}. Dacă micșorați numărul, surplusul se șterge imediat.',
    cacheInfo: 'Analize salvate acum: {0} din {1}'
  },

  en: {
    close: 'Close',
    copy: 'Copy',
    copied: 'Copied ✓',
    shareTitle: 'Video analysis',
    shareCategory: 'Topic/category',
    shareScore: 'Credibility score',
    shareFooter: 'Analysis done by Gemini',
    reanalyze: '↻ Re-analyze',
    disclaimer: 'Automated AI analysis – may be wrong',
    loading: 'Gemini is watching and analyzing the video…',
    loadingHint: 'This may take up to a minute. You can close this window – the result will be saved.',
    credibility: 'Credibility',
    scoreHow: 'How was this score determined?',
    scoreHowHover: 'Click to see how the score was determined',
    titleShowOriginal: 'Click to show the original title',
    titleShowTranslated: 'Click to show the translation',
    scoreHowOld: 'No score explanation for this analysis (saved by an earlier version). Click "Re-analyze" to get one.',
    partial: 'The video itself could not be watched (private, age-restricted, live or too long). This analysis is based on the title and channel only.',
    aiSuspectedTitle: 'Made with AI',
    aiSuspected: 'Signs this video was generated or edited with AI.',
    summary: 'Summary',
    keyPoints: 'Key points',
    redFlags: 'Red flags',
    analyzedAt: 'Analyzed {0}',
    statPublished: 'Published',
    statViews: 'Views',
    statLikes: 'Likes',
    statLength: 'Length',
    statSubs: 'Subscribers',
    statPopularity: 'Popularity',
    popularityHint: 'Popularity score (0–100), computed locally: total views (50%), likes-to-views ratio (25%) and views per day (25%). Unrelated to credibility.',
    statsUnavailable: 'Video details (date, views, likes) are unavailable right now',
    notYoutube: 'Open a YouTube video and click the icon again to get an analysis.',
    noKey: 'To get started, set a Google AI Studio API key.',
    openSettings: 'Open settings',
    tryAgain: 'Try again',
    err_UNKNOWN: 'An unexpected error occurred',
    err_NETWORK: 'Cannot reach the Gemini server',
    err_QUOTA: 'Gemini request quota exceeded. Try again later.',
    err_BAD_KEY: 'The API key is invalid',
    err_BAD_MODEL: 'Model "{0}" was not found. Change it in settings.',
    err_EMPTY: 'Gemini returned no answer ({0})',
    err_PARSE: 'Gemini returned a malformed answer',
    err_API: 'Gemini error: {0}',
    cat_verified_news: 'Verified news',
    cat_news_unverified: 'Unverified report',
    cat_opinion: 'Opinion / commentary',
    cat_educational: 'Educational',
    cat_entertainment: 'Entertainment',
    cat_satire: 'Satire / humor',
    cat_promotional: 'Promotional / ad',
    cat_misleading: 'Misleading / manipulative',
    cat_fake: 'Fake / disinformation',
    optTitle: 'YouTruth – Settings',
    languageLabel: 'Language',
    languageHint: 'Language of the interface and of the analysis Gemini returns.',
    apiKeyLabel: 'Gemini API key',
    show: 'Show',
    hide: 'Hide',
    apiKeyHint: 'Create a key at <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noopener">Google AI Studio</a>. The key is stored locally in your browser and sent only to Google\'s servers.',
    modelLabel: 'Model',
    modelHint: 'Default: gemini-3.5-flash-lite. "Check key" verifies that the key is valid and the selected model is available to your account.',
    usageLabel: 'Token usage (on this device)',
    usageHint: 'Counts the requests the extension sent to Gemini, their tokens, and an estimated cost at the model\'s paid-tier price (nothing is actually billed on the free tier). Data stays on this device and is an estimate based on what Gemini returns. Actual billing is shown in AI Studio.',
    usageTotal: 'Total since {0}: {1} requests · input {2} · output {3} tokens · estimated cost {4}',
    usageNone: 'No data yet. It will appear after the first analysis.',
    usageReset: 'Reset counter',
    usageResetConfirm: 'Reset the token counter?',
    usageResetDone: 'Counter reset',
    pricingLink: 'Gemini API pricing ↗',
    modelDescLite: 'Cheap and fast, suited to everyday use and many analyses.',
    modelDescFlash: 'The smartest Flash model, but more expensive.',
    modelPrice: 'Paid price: ${0} input / ${1} output per million tokens.',
    modelPriceFrom: 'From {0}: ${1} / ${2}.',
    autoLabel: 'Automatically analyze every video I open',
    autoHint: 'When on, analysis starts as soon as you open a video and the score appears on the icon. When off, analysis runs only when you click the icon (saves quota).',
    shortsDelayLabel: 'Delay before analyzing a Short (seconds)',
    shortsDelayHint: 'For Shorts, analysis starts only after you stay on the same Short for this many seconds (⏳ on the icon), so requests aren\'t spent on Shorts you just scroll past. If the value is 0, there is no waiting and analysis starts at once. Applies only when automatic analysis is on.',
    detailsLabel: 'Show Details',
    detailsHint: 'When checked, the popup also shows the video\'s key points. When unchecked, they are not shown.',
    save: 'Save',
    test: 'Check key',
    clearCache: 'Clear saved results',
    billing: 'AI Studio billing & usage ↗',
    saved: 'Saved ✓',
    enterKeyFirst: 'Enter a key first',
    checking: 'Checking…',
    keyOkModel: 'Key is valid ✓ (model {0} is available)',
    keyOkNoModel: 'Key is valid, but model "{0}" is not in the list',
    errorPrefix: 'Error: {0}',
    cacheCleared: 'Saved results cleared',
    fpsLabel: 'Frame sampling rate for long videos',
    fpsHint: 'Applies to videos longer than {0} minutes. A lower rate sends Gemini fewer frames so it costs less, but may miss fast visual changes. Audio stays complete. Short videos always use the full rate. If Gemini rejects the setting, the extension falls back to the full rate automatically.',
    fpsOpt1: '1 per second – full sampling (default)',
    fpsOpt05: '0.5 per second – saves about 34% of input',
    fpsOpt025: '0.25 per second – saves about 50% of input',
    agenticLabel: 'Agentic analysis for long videos (experimental)',
    agenticHint: 'The model decides which parts of the video to watch instead of receiving all of it, which can save up to 88% of tokens. Applies only to videos longer than {0} minutes and to models that support it. The feature is new and sometimes fails; the extension then falls back to normal analysis and won\'t retry for 24 hours. When on, it takes precedence over the sampling rate.',
    cacheMaxLabel: 'Number of analyses to keep',
    cacheMaxHint: 'This saves requests when you return to a video that was already analyzed. When this number is reached, the oldest analyses are removed. Allowed range: {0} to {1}. Lowering it removes the extra ones right away.',
    cacheInfo: 'Currently saved analyses: {0} of {1}'
  }
};

let currentLang = DEFAULTS.language;

function setLang(lang) {
  currentLang = LANGS[lang] ? lang : 'en';
  if (self.document) {
    document.documentElement.lang = currentLang;
    document.documentElement.dir = LANGS[currentLang].dir;
  }
}

function t(key, ...args) {
  const s = STRINGS[currentLang]?.[key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\d)\}/g, (_, i) => args[i] ?? '');
}

// Fills elements marked with data-i18n (text) / data-i18n-html (trusted markup from STRINGS).
function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((n) => { n.innerHTML = t(n.dataset.i18nHtml); });
}

function fillLangSelect(select) {
  select.replaceChildren(...Object.entries(LANGS).map(([code, l]) =>
    Object.assign(document.createElement('option'), { value: code, textContent: l.name })));
  select.value = currentLang;
}

// ---------- helpers shared by popup and service worker ----------

function getVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host !== 'youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

const isShortsUrl = (url) => {
  try { return new URL(url).pathname.startsWith('/shorts/'); } catch { return false; }
};

// "1,234" / "like this video along with 246 other people" → 1234 / 246; null if there are no digits.
const toInt = (v) => {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

// Video stats: { publishDate, views, likes, lengthSeconds, subscribers } – any field may be null.
const statsComplete = (s) => !!(s && s.publishDate && s.views != null && s.likes != null);

// Values of `primary` win; `fallback` only fills the gaps.
function mergeStats(primary, fallback) {
  if (!primary || !fallback) return primary || fallback || null;
  const merged = { ...fallback };
  for (const [k, v] of Object.entries(primary)) if (v != null) merged[k] = v;
  return merged;
}

// Reads the stats of the video open in a tab (null if the player isn't ready or shows another video).
// Throws if the page can't be scripted.
async function readStatsFromTab(tabId, videoId) {
  if (tabId == null || !videoId) return null;
  if (!chrome.scripting) throw new Error('"scripting" permission missing – reload the extension');
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: readStatsFromPage, args: [videoId]
  });
  return injection?.result || null;
}

// Runs inside the YouTube page itself (MAIN world), so it must be fully self-contained
// (hence its own copy of toInt). Reads the data of the video the user is looking at right now –
// no extra network request, and it works with the user's own session / consent state.
function readStatsFromPage(expectedId) {
  const toInt = (v) => {
    const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  // "246", "1,234", "1.2K", "3M" → number
  const parseCount = (text) => {
    const m = String(text || '').trim().match(/^([\d.,]+)\s*([KMB])?$/i);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
    return mult === 1 ? toInt(m[1]) : Math.round(parseFloat(m[1].replace(/,/g, '')) * mult);
  };

  const pr = document.querySelector('#movie_player')?.getPlayerResponse?.();
  const details = pr?.videoDetails;
  if (!details || details.videoId !== expectedId) return null; // still showing the previous video

  const micro = pr.microformat?.playerMicroformatRenderer || {};

  let likes = toInt(micro.likeCount);
  if (likes == null) {
    const btn = document.querySelector(
      'like-button-view-model button, ytd-segmented-like-dislike-button-renderer button, #segmented-like-button button');
    const label = btn?.getAttribute('aria-label') || '';
    likes = toInt(label.match(/\d[\d,.\s]*/)?.[0]) ?? parseCount(btn?.textContent);
  }

  const subsText = document.querySelector('#owner-sub-count')?.textContent?.trim() || '';
  const subscribers = subsText.replace(/\s*(subscribers?|מנויים|abona[țt]i|abonat)\s*$/i, '').trim() || null;

  return {
    publishDate: micro.publishDate || micro.uploadDate || null,
    views: toInt(details.viewCount) ?? toInt(micro.viewCount),
    likes,
    lengthSeconds: toInt(details.lengthSeconds) ?? toInt(micro.lengthSeconds),
    subscribers
  };
}
