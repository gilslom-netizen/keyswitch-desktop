var EN_TO_HE = {
  'q': '/', 'w': "'", 'e': 'ק', 'r': 'ר', 't': 'א', 'y': 'ט', 'u': 'ו', 'i': 'ן', 'o': 'ם', 'p': 'פ',
  '[': ']', ']': '[', 'a': 'ש', 's': 'ד', 'd': 'ג', 'f': 'כ', 'g': 'ע', 'h': 'י', 'j': 'ח', 'k': 'ל',
  'l': 'ך', ';': 'ף', "'": ',', 'z': 'ז', 'x': 'ס', 'c': 'ב', 'v': 'ה', 'b': 'נ', 'n': 'מ', 'm': 'צ',
  ',': 'ת', '.': 'ץ', '/': '.', '`': ';', '(': ')', ')': '(', '{': '}', '}': '{', '>': '<', '<': '>'
};
var HE_TO_EN = {
  '/': 'q', "'": 'w', 'ק': 'e', 'ר': 'r', 'א': 't', 'ט': 'y', 'ו': 'u', 'ן': 'i', 'ם': 'o', 'פ': 'p',
  ']': '[', '[': ']', 'ש': 'a', 'ד': 's', 'ג': 'd', 'כ': 'f', 'ע': 'g', 'י': 'h', 'ח': 'j', 'ל': 'k',
  'ך': 'l', 'ף': ';', ',': "'", 'ז': 'z', 'ס': 'x', 'ב': 'c', 'ה': 'v', 'נ': 'b', 'מ': 'n', 'צ': 'm',
  'ת': ',', 'ץ': '.', '.': '/', ';': '`', ')': '(', '(': ')', '}': '{', '{': '}', '<': '>', '>': '<'
};

// ---------------------------------------------------------------------------
// BASE_DICTIONARY: words that should ALWAYS be normalized to their correct
// spelling, in any case. These tokens have NO meaningful Hebrew word when the
// keyboard layout is flipped (their layout-conversion is gibberish), so there
// is never a reason to leave them as Hebrew.
// ---------------------------------------------------------------------------
var BASE_DICTIONARY = {
  // Companies / brands
  "google": "Google", "apple": "Apple", "microsoft": "Microsoft", "amazon": "Amazon", "facebook": "Facebook",
  "meta": "Meta", "tesla": "Tesla", "netflix": "Netflix", "adobe": "Adobe", "intel": "Intel", "amd": "AMD",
  "nvidia": "NVIDIA", "samsung": "Samsung", "ibm": "IBM", "oracle": "Oracle", "cisco": "Cisco", "dell": "Dell",
  "sony": "Sony", "uber": "Uber", "airbnb": "Airbnb", "spotify": "Spotify", "snapchat": "Snapchat", "tiktok": "TikTok",
  "twitter": "Twitter", "linkedin": "LinkedIn", "github": "GitHub", "gitlab": "GitLab", "bitbucket": "Bitbucket",
  "stackoverflow": "StackOverflow", "discord": "Discord", "vercel": "Vercel", "shopify": "Shopify",
  "cloudflare": "Cloudflare", "heroku": "Heroku", "digitalocean": "DigitalOcean", "stripe": "Stripe",
  "paypal": "PayPal", "zoom": "Zoom", "slack": "Slack", "trello": "Trello", "jira": "Jira", "figma": "Figma",
  "canva": "Canva", "openai": "OpenAI", "anthropic": "Anthropic", "claude": "Claude", "gemini": "Gemini",
  "mistral": "Mistral", "whatsapp": "WhatsApp", "instagram": "Instagram", "youtube": "YouTube", "reddit": "Reddit",
  "pinterest": "Pinterest", "twitch": "Twitch", "salesforce": "Salesforce", "sap": "SAP", "vmware": "VMware",
  "hp": "HP", "lenovo": "Lenovo", "logitech": "Logitech", "razer": "Razer",
  "cloud": "Cloud", "azure": "Azure", "aws": "AWS", "gcp": "GCP", "saas": "SaaS", "paas": "PaaS", "iaas": "IaaS",
  // Tech acronyms whose flipped-layout form is meaningless in Hebrew -> safe to always normalize
  "dom": "DOM", "llm": "LLM", "gpt": "GPT", "ml": "ML", "cpu": "CPU", "ram": "RAM", "json": "JSON",
  "html": "HTML", "url": "URL", "http": "HTTP", "https": "HTTPS", "ide": "IDE",
  "sql": "SQL", "qa": "QA", "cd": "CD", "it": "IT", "hr": "HR", "npm": "NPM"
};

// ---------------------------------------------------------------------------
// AMBIGUOUS_DICTIONARY: tokens that, when the layout is flipped, form a REAL
// Hebrew word (api -> שפן, ai -> שן, css -> בדד, go -> עם ...). We must NOT
// blindly normalize these, because the user might genuinely have meant the
// Hebrew word. Rule: normalize to the English/acronym form ONLY when the body
// was intentionally typed in UPPERCASE, i.e. the word body is all uppercase
// AND Caps Lock was NOT detected for the text as a whole. Otherwise the token
// flows to the normal Hebrew conversion like any other text.
// (The comment after each entry is the Hebrew word it would otherwise form.)
// ---------------------------------------------------------------------------
var AMBIGUOUS_DICTIONARY = {
  "api": "API",   // שפן
  "ai":  "AI",    // שן
  "css": "CSS",   // בדד
  "js":  "JS",    // חד
  "sdk": "SDK",   // דגל
  "pr":  "PR",    // פר
  "ci":  "CI",    // בן
  "gpu": "GPU",   // עפו
  "go":  "Go",    // עם
  "dns": "DNS",   // גמד
  "av":  "AV",    // שה
  "acer": "Acer", // שבקר
  "asus": "ASUS"  // שדוד
};

// Single lowercase Hebrew-prefix letters (ו/ש/מ/ל/ב/ה/כ). When one of these
// precedes an uppercase ambiguous body (e.g. "vAPI" = ה + API) it is treated
// as a prefix and NOT counted as part of the "is the word uppercase" test: it
// is converted to its Hebrew letter while the body stays English.
// NOTE: '.' and ',' are intentionally NOT prefixes. A dictionary word must not
// be "recognized" when a comma or period sits immediately before it (e.g.
// ",api" / ".css") — see the (?<![.,]) lookbehinds below — so we must not
// generate ",word"/".word" dictionary keys here either.
var PREFIXES = {
  'u': 'ו', 's': 'ש', 'n': 'מ', 'k': 'ל', 'c': 'ב', 'v': 'ה', 'f': 'כ'
};
var PREFIX_LETTER_CLASS = 'usnkcvf'; // alphabetic prefixes relevant for ambiguous bodies

var WORD_DICTIONARY = { ...BASE_DICTIONARY };
for (const [key, val] of Object.entries(BASE_DICTIONARY)) {
  for (const [pKey, pVal] of Object.entries(PREFIXES)) {
    WORD_DICTIONARY[pKey + key] = pVal + val;
  }
}

var SESSION_ID = Math.random().toString(36).substring(2, 8);
var PLACEHOLDER_PREFIX = `__KS_${SESSION_ID}_`;
var PLACEHOLDER_REGEX = new RegExp(`(${PLACEHOLDER_PREFIX}\\d+__)`, 'g');

var escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Heuristic Caps Lock detection.
// A real Caps-Lock slip affects a whole phrase, not a 3-4 letter token, so we
// require a minimum number of letters before concluding "Caps Lock was on".
// This prevents a legitimately-uppercase short acronym (API, JSON, HTTPS typed
// on purpose) from being mistaken for a Caps Lock slip.
function isCapsLock(text) {
  const letters = text.match(/[a-zA-Z]/g) || [];
  if (letters.length < 6) return false;
  const upper = letters.filter(c => c >= 'A' && c <= 'Z').length;
  return upper / letters.length >= 0.8;
}

// `directionHint` (optional): 'he2en' | 'en2he'. When the caller already knows
// the conversion direction (e.g. the auto-correct engine, which detected the
// wrong-layout word before calling here), pass it so we don't have to re-guess
// it from the text. The internal isMainlyHebrew heuristic is length-sensitive
// and unreliable on the short word-runs the auto-corrector feeds us (a single
// trailing space is enough to tip a 2-3 letter Hebrew run below the threshold),
// which made ambiguous keys that exist in BOTH layout maps (' , . / ;) resolve
// the wrong way — e.g. "we" typed on the Hebrew layout came out as ",e" instead
// of "we". With the hint we trust the caller's decision. No hint = old behavior.
function convertFullText(text, directionHint) {
  if (!text) return "";

  // Normalize line endings to a single LF. Source text (especially from
  // contenteditable fields) often uses CRLF ("\r\n"); if both characters
  // survive conversion, the editor renders each one as its own line break,
  // turning every Enter into two. Collapsing to "\n" prevents that doubling.
  text = text.replace(/\r\n?/g, '\n');

  const isSingleWord = !/\s/.test(text.trim());
  const hebChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  let isMainlyHebrew = hebChars > text.length / 3;
  if (directionHint === 'he2en') isMainlyHebrew = true;
  else if (directionHint === 'en2he') isMainlyHebrew = false;
  const capsDetected = isCapsLock(text);

  const placeholders = [];
  let workingText = text;

  // --- Pass 1: BASE dictionary (always normalize, case-insensitive) ---------
  // (?<![.,]) ensures a word glued directly to a preceding comma/period
  // (e.g. ",google" / ".api") is NOT treated as a dictionary word — it flows to
  // the normal character-by-character conversion instead. A normal space after
  // punctuation ("word, google") is unaffected.
  const sortedKeys = Object.keys(WORD_DICTIONARY).sort((a, b) => b.length - a.length);
  const pattern = sortedKeys.map(escapeRegex).join('|');
  const dictRegex = new RegExp(`(?<![.,])\\b(${pattern})\\b`, 'gi');

  workingText = workingText.replace(dictRegex, (match) => {
    const idx = placeholders.length;
    placeholders.push(WORD_DICTIONARY[match.toLowerCase()]);
    return `${PLACEHOLDER_PREFIX}${idx}__`;
  });

  // --- Pass 2: AMBIGUOUS dictionary -----------------------------------------
  // Body is matched case-INSENSITIVELY (so we actually see "API"/"Api"/"api"),
  // with an optional single lowercase Hebrew-prefix in front. The decision of
  // whether to keep the English form is made inside the callback.
  const ambigKeys = Object.keys(AMBIGUOUS_DICTIONARY).sort((a, b) => b.length - a.length);
  const ambigPattern = ambigKeys.map(escapeRegex).join('|');
  // (?<![.,]) — same rule as Pass 1: do not recognize an ambiguous token that is
  // glued directly to a preceding comma/period.
  const ambigRegex = new RegExp(`(?<![.,])\\b([${PREFIX_LETTER_CLASS}]?)(${ambigPattern})\\b`, 'gi');

  workingText = workingText.replace(ambigRegex, (full, prefix, body) => {
    const bodyIsAllUpper = /[A-Z]/.test(body) && body === body.toUpperCase();
    const prefixIsLowerSign = prefix !== "" && prefix === prefix.toLowerCase();
    const prefixOk = (prefix === "") || prefixIsLowerSign;

    // Keep the English/acronym form ONLY if the body was intentionally
    // uppercased: body all-caps, Caps Lock not detected, and any prefix is a
    // genuine lowercase Hebrew-prefix sign (or there is no prefix at all).
    if (bodyIsAllUpper && !capsDetected && prefixOk) {
      const eng = AMBIGUOUS_DICTIONARY[body.toLowerCase()];
      const hePrefix = prefix ? (PREFIXES[prefix.toLowerCase()] || "") : "";
      const idx = placeholders.length;
      placeholders.push(hePrefix + eng);
      return `${PLACEHOLDER_PREFIX}${idx}__`;
    }
    // Otherwise leave the whole match untouched -> it will be converted to
    // Hebrew character-by-character below, exactly like any other text.
    return full;
  });

  // --- Pass 3: character-by-character layout conversion ---------------------
  let result = "";
  let isSentenceStart = true;
  const parts = workingText.split(PLACEHOLDER_REGEX);

  for (let part of parts) {
    if (part.startsWith(PLACEHOLDER_PREFIX)) {
      const idx = parseInt(part.replace(PLACEHOLDER_PREFIX, "").replace("__", ""));
      result += placeholders[idx];
      isSentenceStart = false;
    } else {
      for (let i = 0; i < part.length; i++) {
        const char = part[i];
        if (char === '\n' || char === '\r') {
          result += char;
          isSentenceStart = true;
          continue;
        }

        if (/[A-Z]/.test(char) && i + 1 < part.length) {
          const remainingPart = part.substring(i + 1);
          const nextTwoChars = remainingPart.substring(0, 2);
          const hasTwoHebrewFollow = (nextTwoChars.match(/[\u0590-\u05FF]/g) || []).length >= 2;

          if (hasTwoHebrewFollow || isMainlyHebrew) {
            result += char;
            isSentenceStart = false;
            continue;
          }
        }

        // Resolve the character through the layout maps. Punctuation keys
        // ("'", ",", ".", "/", ";" …) exist in BOTH maps, so the order matters:
        // when the text is mainly Hebrew we are converting Hebrew->English, so
        // such an ambiguous key must use HE_TO_EN first (e.g. "'" -> "w", so
        // "'שמא" becomes "want", not ",ant"). Otherwise EN_TO_HE wins as before.
        let conv;
        if (isMainlyHebrew && HE_TO_EN[char]) {
          conv = HE_TO_EN[char];
        } else {
          conv = EN_TO_HE[char] || EN_TO_HE[char.toLowerCase()] || HE_TO_EN[char] || char;
        }
        if (HE_TO_EN[char] && /[a-zA-Z]/.test(conv)) {
          if (isSingleWord) {
            conv = (result.length === 0) ? conv.toUpperCase() : conv.toLowerCase();
          } else {
            conv = isSentenceStart ? conv.toUpperCase() : conv.toLowerCase();
          }
          isSentenceStart = false;
        } else if (/[a-zA-Z\u0590-\u05FF]/.test(char)) {
          isSentenceStart = false;
        }
        result += conv;
        if (/[.!?]/.test(conv)) isSentenceStart = true;
      }
    }
  }

  // --- Pass 3.5: capitalize standalone "i" → "I" --------------------------------
  // "ן" (Hebrew-layout key for "i") as a standalone word is always the English
  // first-person pronoun and must be capitalized regardless of sentence position.
  // \b works reliably here because "i" is an ASCII word character.
  result = result.replace(/\bi\b/g, 'I');

  // --- Pass 4: final safety pass for BASE words formed during conversion -----
  // The preceding-char class excludes '.' and ',' so a word glued to a comma or
  // period is left alone here too (consistent with Passes 1 & 2).
  for (const [key, val] of Object.entries(WORD_DICTIONARY)) {
    const escapedKey = escapeRegex(key);
    const postRegex = new RegExp(`(^|[^a-zA-Z\u0590-\u05FF.,])${escapedKey}(?=[^a-zA-Z\u0590-\u05FF]|$)`, 'gi');
    result = result.replace(postRegex, (match, p1) => p1 + val);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CommonJS export (desktop app). The file body above is kept byte-identical to
// the browser-extension version so fixes can be synced between the projects.
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EN_TO_HE, HE_TO_EN, convertFullText, isCapsLock, WORD_DICTIONARY, AMBIGUOUS_DICTIONARY, PREFIXES };
}
