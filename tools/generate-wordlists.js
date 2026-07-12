// generate-wordlists.js - KeySwitch Desktop
// =============================================================================
// Generates src/engine/wordlists-extra.js (and optionally the browser
// extension's wordlists_extra.js) from the OpenSubtitles 2018 frequency
// corpora (https://github.com/hermitdave/FrequencyWords):
//
//   node tools/generate-wordlists.js <en_50k.txt> <he_50k.txt> [--ext <dir>]
//
// Corpus line format: "word count", frequency-descending.
//
// SAFETY RULES — a candidate word is added ONLY if it cannot collide across
// keyboard layouts. The danger is NOT just ambiguity; an unsafe word makes
// the engine MISCORRECT legitimate text of the other language:
//
//  * English candidate W (e.g. "go"): classify() flags a Hebrew word X as
//    "wrong" when swapLayout(X,'he2en') is in COMMON_EN. So if
//    swapLayout(W,'en2he') is a real Hebrew word (e.g. go→עם), a user typing
//    that Hebrew word correctly would have it "corrected" into W. W is
//    therefore rejected if its Hebrew flip — or the flip with up to two
//    leading prefix letters (ובלכשמה) stripped, since prefixed forms like
//    ועם are legitimate Hebrew — exists in the 50k Hebrew lexicon.
//
//  * Hebrew candidate H: classify() flags an English word E as "wrong" when
//    swapLayout(E,'en2he') is in COMMON_HE, or equals prefix+H. So H is
//    rejected if swapLayout(H,'he2en') — or swapLayout(p+H,'he2en') for any
//    prefix letter p — exists in the 50k English lexicon.
//
// Checks run against the FULL 50k reference lexicons (plus our own base
// dictionaries), not just the words we ship, so collisions with common words
// we happen not to include are still caught.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const dict = require('../src/engine/dictionaries');

const DESKTOP_TARGET = 5500; // per language (user floor: 5000, keep a margin)
const EXT_TARGET = 4000;     // extension subset (desktop keeps the advantage)

const HE_ONLY = /^[א-ת]+$/;
const EN_ONLY = /^[a-z]+$/;

function parseArgs() {
  const args = process.argv.slice(2);
  const extIdx = args.indexOf('--ext');
  let extDir = null;
  if (extIdx >= 0) {
    extDir = args[extIdx + 1];
    args.splice(extIdx, 2);
  }
  const [enPath, hePath] = args;
  if (!enPath || !hePath) {
    console.error('usage: node tools/generate-wordlists.js <en_50k.txt> <he_50k.txt> [--ext <extension-dir>]');
    process.exit(1);
  }
  return { enPath, hePath, extDir };
}

function loadCorpus(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function main() {
  const { enPath, hePath, extDir } = parseArgs();
  const enCorpus = loadCorpus(enPath);
  const heCorpus = loadCorpus(hePath);

  // Reference lexicons: every real word of each language we know about.
  const EN_LEX = new Set(enCorpus.filter((w) => /^[a-z']+$/.test(w)));
  dict.BASE_EN.forEach((w) => EN_LEX.add(w.toLowerCase()));
  dict.EN_PRIMARY_ADD_EN.forEach((w) => EN_LEX.add(w));
  const HE_LEX = new Set(heCorpus.filter((w) => HE_ONLY.test(w)));
  dict.BASE_HE.forEach((w) => HE_LEX.add(w));
  dict.HE_PRIMARY_ADD_HE.forEach((w) => HE_LEX.add(w));

  const knownEN = new Set(dict.FULL_EN.concat(dict.EN_PRIMARY_ADD_EN));
  const knownHE = new Set(dict.FULL_HE.concat(dict.HE_PRIMARY_ADD_HE));

  // English word W is safe iff no legitimate Hebrew typing flips into it.
  function safeEN(w) {
    const flip = dict.swapLayout(w, 'en2he');
    if (!HE_ONLY.test(flip)) return true; // flip has punctuation → not a Hebrew word
    if (HE_LEX.has(flip)) return false;
    let s = flip;
    for (let i = 0; i < 2 && s.length > 3 && dict.HE_PREFIXES.indexOf(s[0]) >= 0; i++) {
      s = s.slice(1);
      if (HE_LEX.has(s)) return false;
    }
    return true;
  }

  // Hebrew word H is safe iff no legitimate English typing flips into it
  // (directly, or via classify()'s prefix rule p+H).
  function safeHE(h) {
    const flip = dict.swapLayout(h, 'he2en').toLowerCase();
    if (EN_ONLY.test(flip) && EN_LEX.has(flip)) return false;
    for (const p of dict.HE_PREFIXES) {
      const pf = dict.swapLayout(p + h, 'he2en').toLowerCase();
      if (EN_ONLY.test(pf) && EN_LEX.has(pf)) return false;
    }
    return true;
  }

  const extraEN = [];
  let scannedEN = 0;
  for (const w of enCorpus) {
    if (extraEN.length >= DESKTOP_TARGET) break;
    scannedEN++;
    if (!EN_ONLY.test(w) || w.length < 3) continue;
    if (knownEN.has(w)) continue;
    if (!safeEN(w)) continue;
    knownEN.add(w);
    extraEN.push(w);
  }

  const extraHE = [];
  let scannedHE = 0;
  for (const w of heCorpus) {
    if (extraHE.length >= DESKTOP_TARGET) break;
    scannedHE++;
    if (!HE_ONLY.test(w) || w.length < 3) continue;
    if (knownHE.has(w)) continue;
    if (!safeHE(w)) continue;
    knownHE.add(w);
    extraHE.push(w);
  }

  console.log(`EN: kept ${extraEN.length} of first ${scannedEN} corpus words`);
  console.log(`HE: kept ${extraHE.length} of first ${scannedHE} corpus words`);
  if (extraEN.length < 5000 || extraHE.length < 5000) {
    console.error('FAILED: fewer than 5000 words survived filtering for a language');
    process.exit(1);
  }

  const wrap = (words, indent) => {
    const lines = [];
    let line = '';
    for (const w of words) {
      if (line && (line.length + w.length + 1) > 110) { lines.push(line); line = ''; }
      line = line ? line + ' ' + w : w;
    }
    if (line) lines.push(line);
    return lines.map((l) => `${indent}${l}`).join('\n');
  };

  const desktopFile = path.join(__dirname, '..', 'src', 'engine', 'wordlists-extra.js');
  fs.writeFileSync(desktopFile,
    `// wordlists-extra.js - KeySwitch Desktop
// =============================================================================
// AUTO-GENERATED by tools/generate-wordlists.js — DO NOT EDIT BY HAND.
// ${extraEN.length} English + ${extraHE.length} Hebrew frequency-ranked words from the
// OpenSubtitles 2018 corpora, filtered so no added word can collide across
// keyboard layouts (see the generator header for the exact safety rules).
// =============================================================================
'use strict';

const EXTRA_EN = \`
${wrap(extraEN, '')}
\`.split(/\\s+/).filter(Boolean);

const EXTRA_HE = \`
${wrap(extraHE, '')}
\`.split(/\\s+/).filter(Boolean);

module.exports = { EXTRA_EN, EXTRA_HE };
`);
  console.log(`wrote ${desktopFile}`);

  if (extDir) {
    const extEN = extraEN.slice(0, EXT_TARGET);
    const extHE = extraHE.slice(0, EXT_TARGET);
    const extFile = path.join(extDir, 'wordlists_extra.js');
    fs.writeFileSync(extFile,
      `// wordlists_extra.js - KeySwitch
// =============================================================================
// AUTO-GENERATED by the desktop repo's tools/generate-wordlists.js —
// DO NOT EDIT BY HAND. ${extEN.length} English + ${extHE.length} Hebrew frequency-ranked
// words (a subset of the desktop app's extended dictionaries), filtered so no
// added word can collide across keyboard layouts. Loaded as a content script
// before autocorrect.js, which picks it up via the KS_EXTRA_WORDS global.
// =============================================================================
'use strict';

var KS_EXTRA_WORDS = {
  EN: \`
${wrap(extEN, '')}
\`.split(/\\s+/).filter(Boolean),
  HE: \`
${wrap(extHE, '')}
\`.split(/\\s+/).filter(Boolean)
};
`);
    console.log(`wrote ${extFile}`);
  }
}

main();
