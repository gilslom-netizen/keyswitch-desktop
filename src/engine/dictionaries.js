// dictionaries.js - KeySwitch Desktop
// =============================================================================
// Word dictionaries + wrong-layout classification, ported from the KeySwitch
// browser extension (autocorrect.js). The dictionary contents and the
// classification rules are kept identical to the extension so both projects
// detect exactly the same mistakes.
// =============================================================================
'use strict';

const { EN_TO_HE, HE_TO_EN } = require('./shared_logic');

const enToHe = EN_TO_HE;
const heToEn = HE_TO_EN;

const HEB_RANGE = /[֐-׿]/;
const FINALS = 'ךםןףץ';
const HE_PREFIXES = 'ובלכשמה';

const BASE_EN = (
  "the be to of and a in that have i it for not on with he you do at this but his by from they we say her she or will my one all would there their what up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come over think also back after use two how first well way even want because any give day most us is are was were been has had did does said got make made went knew saw came find here where why must shall done being more less very much many few little big small new old high low long short next last yes ok hi hello hey thanks thank please sorry great nice cool love need help home name email password user login search send message chat call phone today tomorrow week month money work school class book read write open close start stop play game web site page link file photo video music app gmail facebook instagram whatsapp youtube google account number address city street country world man woman boy girl child mother father friend family water food money house car door window table chair room job team play happy sad fun true false right wrong same different open free fast slow easy hard hot cold light dark white black red blue green please thanks again maybe sure yeah nope okay great awesome amazing perfect ready done now later soon never always sometimes every each both another other such only also just even still yet already almost enough quite rather really actually probably maybe perhaps "
  + "lol lmao omg wow bro btw idk imo fyi yo bye guys gonna wanna pls thx cool nvm asap "
  + "you daniel dani yossi moshe david yaakov sarah rachel noa michal yael tamar ronit "
  + "shira itay eitan omer uri guy ron lior maya naama adam yonatan alon nadav amit nir "
  + "gal rotem ofir asaf yuval avi dana eli oren shani liat "
  + "tomer ariel idan roni hadas efrat sivan oded gilad doron "
  + "should an am these those thing try "
  + "life place week system program extension button click switch key code text word show "
  + "coming context application browser screen mouse laptop mobile numbers letters string function object array value error type input output event double select update "
  + "user users errors click clicks clicked clicking systems files pages keys buttons words works worked working game games test tests tested testing load loads loading save saves saving create creates created creating delete deletes deleted remove removes removed setting settings choose choice change changes changed project projects version versions download downloads account accounts local global "
  + "added adding fixed fixing learn learned learning sleep sleeping eating received paying paid writing written continue stopped stopping started starting break breaking breaks finish finished done read reading send sending math divide divided dividing plus minus equal equals total count counts counting always never sometimes between against freedom interview interviews holiday vacation asleep awake"
  + " sent sends called calling calls recommend recommended recommends recommendation question asked asking group groups idea ideas links linked linking summer taste tasty tastes tasted tasting request requests requested exit principle mainly basically connect connected connection village yesterday past present future weekly monthly yearly daily monday tuesday wednesday thursday friday saturday sunday"
).split(/\s+/).filter(Boolean);

const BASE_HE = (
  "של את זה זו זאת אלה אלו לא כן אני אתה הוא היא אנחנו אתם אתן הם הן מה מי איפה איך למה מתי כמה כי גם רק עם על עד אל אם יש אין היה היתה היו יהיה אהיה שלום תודה בבקשה סליחה אנא טוב טובה רע רעה יפה יפה גדול גדולה קטן קטנה חדש חדשה ישן ישנה הרבה מעט קצת יום יומיים שבוע חודש שנה שעה דקה רגע עכשיו היום מחר אתמול בוקר צהריים ערב לילה בית בתים ילד ילדה ילדים ילדות אישה איש אנשים אמא אבא אח אחות חבר חברה חברים משפחה מים אוכל לחם ספר ספרים עבודה כסף זמן מקום דבר דברים חיים אהבה מורה תלמיד תלמידה כיתה שאלה תשובה כותב קורא רוצה רוצים צריך צריכה יכול יכולה אפשר בוא בואי לך לכי תן תני קח קחי מאוד יותר פחות הכל כלום משהו מישהו שום אחד אחת שתיים שניים שלוש שלושה ארבע חמש שש שבע שמונה תשע עשר עשרה ראשון אחרון הבא טלפון הודעה שלח שלחי כתובת רחוב עיר ארץ עולם שמש ירח כוכב אש רוח אדמה כלב חתול עץ פרח שמיים ים נהר הר דרך כביש מכונית אוטובוס רכבת מטוס מילה משפט שפה עברית אנגלית עוד פעם עכשיו תמיד אף פעם לפעמים כל כך הזה הזאת האלה שלי שלך שלו שלה שלנו שלכם שלהם אותי אותך אותו אותה אותנו כאן שם פה למעלה למטה לפני אחרי בין מתחת מעל ליד נגד בגלל אבל או אז כדי איזה איזו כזה כזאת נכון נכונה אמת שקר רוצה אוהב אוהבת שונא יודע יודעת מבין מבינה זוכר שוכח חושב חושבת מרגיש מרגישה עושה עושים אומר אומרת שואל עונה הולך הולכת בא באה רץ רצה ישן אוכל שותה קם נופל עומד יושב גר עובד לומד מלמד משחק קונה מוכר נותן לוקח פותח סוגר מתחיל גומר הוסף הוספתי תודה "
  + "היי הי סבבה אחלה יאללה מעולה בטח כיף וואלה ממש לגמרי בכיף "
  + "אז תקשיב יודע נחמד שאלה אהלן אבל צריך תיקון עבד רגע את אתה הם אנחנו אתם "
  + "תגיד פרוייקט הפרוייקט פרויקט הפרויקט "
  + "כמו לאיפה אחרת בשביל שיר נע חם "
  + "אולי קודם שוב כבר ארוך קצר חדר מילים תוספת מחשב מקלדת "
  + "תמונה זהב סיפור קבוצה בעיה מספר מילון חלון גב "
  + "ללכת לראות מדבר מדינה חנות שנייה צבע כחול כחולה אדום אדומה ירוק ירוקה צהוב צהובה לבן לבנה שחור שחורה קשה מהר לאט מוקדמת מאוחר פשוט מורכב "
  + "דקה לי לו "
  + "דניאל דני יוסי משה דוד יעקב שרה רחל נועה מיכל יעל תמר רונית שירה איתי איתן "
  + "עומר אורי גיא רון טל ליאור מאיה נעמה אדם יונתן אלון נדב עמית ניר גל רותם "
  + "אופיר אסף יובל אבי דנה אלי אורן שני ליאת "
  + "תומר אריאל עידן רוני הדס אפרת סיון עודד גלעד דורון "
  + "יוסיף תוסיף הוספנו תקן תתקן תוקן תיקנתי התיקון תסיר הוסר יוסר ראיתי אכלתי למדתי ללמוד לאכול ישנתי לישון הסרתי התקנתי הותקן קיבלת קיבלתי צירפתי לצרף שילם שילמתי שולם בוצע צורף ביצעתי עשיתי נעשה כתבתי נכתב כתב כותבת לכתוב ראיון אספתי לאסוף תאסוף חופש חופשי לחלק חלוקת חילוק כפל חיבור חיסור מנה חלוקה הייתי בהמשך המשך להמשיך המשכתי להתחיל התחלתי לעצור עצרתי להפסיק בכל הפסקתי להתקדם התקדמתי שלושה שמינית "
  + "תצרף אצרף יצרף מצרף מצורף "
  + "טובים טובות הטוב וטוב גדולים גדולות הגדול חדשים חדשות החדש קטנה קטנים קטנות הקטן יפים יפות היפה רעים רעות מהיר מהירה מהירים מהירות רחוקה רחוקים רחוקות הרחוק קרובה קרובים קרובות הקרוב רואה רואים רואות הולכים הולכות הודעות משתמש משתמשים משתמשת פיתוח גרסה גרסאות נכונים ראשונה "
  + "עדיין שאני רציתי תודה שרציתי "
  + "האם שלחתי אשלח נשלח תשלח ישלח שולח עבר הווה עתיד העבר העתיד שלשום מחרתיים רעיון הרעיון המלצה להמליץ המליץ תמליץ ההמלצה מומלץ הומלץ קובצה קבוצת הקבוצה קיבוץ הקיבוץ כפר הכפר שלכם בתוך לתוך השאלה לשאול תשאל שאל שלא קיץ הקיץ קישור הקישור לקשר תקשר אקשר יקשר התקשרתי אתקשר להיתקשר להתקשר היתקשר התקשר נתקשר טעם לטעום טעמתי טעים אטעם יטעם נטעם יצאתי אצא לצאת בקשה לבקש ביקש ביקשתי נבקש תבקש אבקש מבקש בעיקרון העיקר עיקר עיקרון העיקרון עקרונית בשבוע השבוע בחודש החודש בשנה השנה ביום שני שלישי רביעי חמישי שבת בראשון בשני בשלישי ברביעי בחמישי בשבת השבת"
).split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------------------
// PRIMARY-LANGUAGE WORD LISTS: These four lists fine-tune the active
// dictionaries based on the user's declared primary typing language.
//
// "Drop" lists remove short words that are valid in BOTH languages and would
// cause false corrections when typed intentionally in the non-primary tongue.
// Example: "he" is a valid English pronoun but also the result of converting
// the Hebrew letter ה — when Hebrew is primary we drop it from COMMON_EN so
// that a lone ה is never mistakenly "corrected" to English.
//
// "Add" lists are the mirror concern: they contain words that are TOO SHORT
// or TOO COMMON AS ABBREVIATIONS to keep in the always-on dictionaries, but
// are safe to recognise once the user has committed to a specific language.
// Example: "אז" (Hebrew for "then") looks like a valid English initialism;
// it is only added to COMMON_HE when Hebrew is the primary language, because
// at that point a user typing "tz" almost certainly meant Hebrew, not an
// acronym. Similarly, English "low"/"fly" etc. are only added to COMMON_EN
// for committed English typists, where a matching Hebrew gibberish sequence
// would be extremely unlikely to be intentional.
// ---------------------------------------------------------------------------

// Words removed from COMMON_EN when Hebrew or mixed is primary
// (short English words that double as plausible Hebrew layout mistakes)
const HE_PRIMARY_DROP_EN = ['be', 'has', 'an', 'am', 'he', 'me', 'it', 'think', 'thing', 'try', 'by', 'up', 'see', 'at'];

// Words removed from COMMON_HE when English or mixed is primary
// (short Hebrew words that double as plausible English layout mistakes)
const EN_PRIMARY_DROP_HE = ['יש', 'שם', 'הן', 'הם', 'שיר', 'מי', 'כי', 'נע', 'חם', 'שש', 'עשר', 'רק', 'גב', 'אף', 'דקה', 'לי', 'לו'];

// Short Hebrew words added to COMMON_HE ONLY when Hebrew is primary.
// These are risky in mixed mode: "גד"/"די" resemble English initialisms,
// "אז"/"אל" are two-letter words that could be typed intentionally in
// English contexts.  When the user declares Hebrew as primary, the
// probability that these represent Hebrew is high enough to correct.
const HE_PRIMARY_ADD_HE = ['גד', 'די', 'אז', 'אל'];

// Short English words added to COMMON_EN ONLY when English is primary.
// "sit" maps to "דןא" which is identical to the DNA initialism in Hebrew;
// "fly" is a very short sequence that could prefix many Hebrew words.
// Safe for committed English typists where Hebrew gibberish is the rare case.
const EN_PRIMARY_ADD_EN = ['low', 'ten', 'pen', 'free', 'less', 'sum', 'sit', 'fly'];

// ---------------------------------------------------------------------------
// EXTENDED WORD LISTS: ~5000 additional frequency-ranked words per language,
// GENERATED by tools/generate-wordlists.js from the OpenSubtitles frequency
// corpora and filtered so that no added word can collide across layouts:
// a word is only added if its layout-flip (and every Hebrew-prefix variant of
// it that classify() considers) is NOT a real word of the other language —
// checked against the full 50k-word reference lexicons, not just our own
// dictionaries. Regenerate with: node tools/generate-wordlists.js
// ---------------------------------------------------------------------------
const EXTRA = require('./wordlists-extra');
const FULL_EN = BASE_EN.concat(EXTRA.EXTRA_EN);
const FULL_HE = BASE_HE.concat(EXTRA.EXTRA_HE);

var COMMON_EN = new Set(FULL_EN);
var COMMON_HE = new Set(FULL_HE);
var primaryLang = 'he';

function applyPrimaryLang(lang) {
  primaryLang = (lang === 'en' || lang === 'mixed') ? lang : 'he';
  COMMON_EN = new Set(FULL_EN);
  COMMON_HE = new Set(FULL_HE);
  if (primaryLang === 'he' || primaryLang === 'mixed') {
    HE_PRIMARY_DROP_EN.forEach((w) => COMMON_EN.delete(w));
  }
  if (primaryLang === 'en' || primaryLang === 'mixed') {
    EN_PRIMARY_DROP_HE.forEach((w) => COMMON_HE.delete(w));
  }
  // Unlock the risky short words only for committed single-language typists
  if (primaryLang === 'he') {
    HE_PRIMARY_ADD_HE.forEach((w) => COMMON_HE.add(w));
  }
  if (primaryLang === 'en') {
    EN_PRIMARY_ADD_EN.forEach((w) => COMMON_EN.add(w));
  }
}
applyPrimaryLang('he');
function swapChar(ch, dir) {
  if (dir === 'en2he') return enToHe[ch] || enToHe[ch.toLowerCase()] || ch;
  return heToEn[ch] || ch;
}
function swapLayout(s, dir) {
  let out = '';
  for (const ch of s) out += swapChar(ch, dir);
  return out;
}
function hasMisplacedFinal(s) {
  for (let i = 0; i < s.length; i++) {
    if (FINALS.indexOf(s[i]) >= 0 && HEB_RANGE.test(s.slice(i + 1))) return true;
  }
  return false;
}

function hasIntentionalUpper(word, capsActive) {
  return !capsActive && /[A-Z]/.test(word);
}

// ---------------------------------------------------------------------------
// CLASSIFICATION: Determines if a word is correctly typed in its current
// language or if it looks like a keyboard layout mistake.
//
// The layout-flip checks run on the RAW token and trim non-letters only AFTER
// flipping. This matters because several punctuation keys TYPE LETTERS on the
// other layout — ',' '.' ';' are the keys of ת ץ ף on the Hebrew layout, and
// '/' and the apostrophe are the keys of q and w — so stripping "punctuation"
// BEFORE flipping (the old behavior) deleted real letters of the intended
// word and silently missed extremely common mistakes: every Hebrew word
// ending in ת/ץ/ף typed on the English layout ("zt," is זאת, "fh;" is כיף),
// and every English word containing q typed on the Hebrew layout. The
// 'correct'-language checks still use the stripped core: a correctly-typed
// word never depends on those keys.
// ---------------------------------------------------------------------------
function classify(word, capsActive) {
  const core = word
    .replace(/^[^A-Za-z֐-׿']+/, '')
    .replace(/[^A-Za-z֐-׿]+$/, '');

  const hasHeb = HEB_RANGE.test(core);
  const hasLat = /[A-Za-z]/.test(core);
  if (hasHeb && hasLat) return { kind: 'unknown' };

  if (hasHeb) {
    if (core.length === 1) {
      if (FINALS.indexOf(core) >= 0) {
        const en = swapLayout(core, 'he2en').toLowerCase();
        if (COMMON_EN.has(en)) return { kind: 'wrong', lang: 'en', direction: 'he2en' };
      }
      return { kind: 'unknown' };
    }
    if (hasMisplacedFinal(core)) return { kind: 'wrong', lang: 'en', direction: 'he2en' };
    if (COMMON_HE.has(core)) return { kind: 'correct', lang: 'he' };
    if (core.length > 2 && HE_PREFIXES.indexOf(core[0]) >= 0 && COMMON_HE.has(core.slice(1))) {
      return { kind: 'correct', lang: 'he' };
    }
    const en = swapLayout(word, 'he2en')
      .replace(/^[^A-Za-z]+/, '')
      .replace(/[^A-Za-z]+$/, '')
      .toLowerCase();
    if (en.length >= 2 && COMMON_EN.has(en)) return { kind: 'wrong', lang: 'en', direction: 'he2en' };
    return { kind: 'unknown' };
  }

  // Typed with latin/digit/punctuation keys.
  if (core.length >= 2 && COMMON_EN.has(core.toLowerCase())) return { kind: 'correct', lang: 'en' };
  if (hasIntentionalUpper(core, capsActive)) return { kind: 'unknown' };
  const he = swapLayout(word.toLowerCase(), 'en2he')
    .replace(/^[^֐-׿]+/, '')
    .replace(/[^֐-׿]+$/, '');
  if (he.length >= 2) {
    if (COMMON_HE.has(he)) return { kind: 'wrong', lang: 'he', direction: 'en2he' };
    if (he.length > 2 && HE_PREFIXES.indexOf(he[0]) >= 0 && COMMON_HE.has(he.slice(1))) {
      return { kind: 'wrong', lang: 'he', direction: 'en2he' };
    }
  }
  return { kind: 'unknown' };
}

module.exports = {
  applyPrimaryLang,
  classify,
  swapLayout,
  getPrimaryLang: () => primaryLang,
  HEB_RANGE,
  FINALS,
  HE_PREFIXES,
  // Exposed for tools/generate-wordlists.js and tests — not used at runtime.
  BASE_EN,
  BASE_HE,
  FULL_EN,
  FULL_HE,
  HE_PRIMARY_ADD_HE,
  EN_PRIMARY_ADD_EN
};
