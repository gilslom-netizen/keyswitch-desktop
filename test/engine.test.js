// engine.test.js - KeySwitch Desktop
// Pure-JS tests for the conversion + detection engine (no Electron / no
// native modules needed — runs on any OS with `npm test`).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { convertFullText } = require('../src/engine/shared_logic');
const dict = require('../src/engine/dictionaries');
const keymap = require('../src/engine/keymap');
const { AutocorrectEngine, computeRunStart } = require('../src/engine/autocorrect-engine');

// ---------------------------------------------------------------------------
// convertFullText
// ---------------------------------------------------------------------------
test('convertFullText: EN-layout gibberish to Hebrew', () => {
  assert.strictEqual(convertFullText('akuo', 'en2he'), 'שלום');
});

test('convertFullText: Hebrew-layout gibberish to English', () => {
  assert.strictEqual(convertFullText('יקךךם', 'he2en').toLowerCase(), 'hello');
});

test('convertFullText: CapsLock gibberish converts to Hebrew', () => {
  assert.strictEqual(convertFullText('AKUO', 'en2he'), 'שלום');
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------
test('classify: detects wrong-layout Hebrew typed on EN keyboard', () => {
  const r = dict.classify('akuo', false);
  assert.deepStrictEqual(r, { kind: 'wrong', lang: 'he', direction: 'en2he' });
});

test('classify: detects wrong-layout English typed on HE keyboard', () => {
  const r = dict.classify('יקךךם', false);
  assert.deepStrictEqual(r, { kind: 'wrong', lang: 'en', direction: 'he2en' });
});

test('classify: correct words are not flagged', () => {
  assert.strictEqual(dict.classify('שלום', false).kind, 'correct');
  assert.strictEqual(dict.classify('hello', false).kind, 'correct');
});

test('classify: intentional uppercase is left alone when CapsLock is off', () => {
  assert.strictEqual(dict.classify('AKUO', false).kind, 'unknown');
});

test('classify: uppercase gibberish IS flagged when CapsLock is on', () => {
  const r = dict.classify('AKUO', true);
  assert.deepStrictEqual(r, { kind: 'wrong', lang: 'he', direction: 'en2he' });
});

// ---------------------------------------------------------------------------
// keymap
// ---------------------------------------------------------------------------
test('keymap: every letter key resolves in both layouts', () => {
  const K = keymap.UiohookKey;
  for (const name of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const en = keymap.keyToChar(K[name], 'en', false, false);
    const he = keymap.keyToChar(K[name], 'he', false, false);
    assert.strictEqual(en, name.toLowerCase());
    assert.ok(he && he !== en, `Hebrew mapping missing for ${name}`);
  }
});

test('keymap: Hebrew layout with CapsLock produces capital Latin letters', () => {
  const K = keymap.UiohookKey;
  assert.strictEqual(keymap.keyToChar(K.A, 'he', false, true), 'A');
  assert.strictEqual(keymap.keyToChar(K.A, 'he', false, false), 'ש');
});

test('keymap: shift symbols on EN layout', () => {
  const K = keymap.UiohookKey;
  assert.strictEqual(keymap.keyToChar(K['1'], 'en', true, false), '!');
  assert.strictEqual(keymap.keyToChar(K.Slash, 'en', true, false), '?');
});

// ---------------------------------------------------------------------------
// computeRunStart
// ---------------------------------------------------------------------------
test('computeRunStart: run starts after a correctly-typed opposite-script word', () => {
  const s = 'שלום akuo';
  const rs = computeRunStart(s, 0, s.length, 'en2he');
  assert.strictEqual(s.slice(rs), 'akuo');
});

test('computeRunStart: whole run converts when everything is wrong-layout', () => {
  const s = 'akuo kv';
  const rs = computeRunStart(s, 0, s.length, 'en2he');
  assert.strictEqual(rs, 0);
});

// ---------------------------------------------------------------------------
// AutocorrectEngine end-to-end with a fake native layer
// ---------------------------------------------------------------------------
function makeFakeNative({ layout = 'en', caps = false } = {}) {
  const calls = { backspaces: 0, typed: '', capsToggles: 0, layoutSet: [] };
  return {
    calls,
    isSupported: true,
    getForegroundWindowId: () => 'win-1',
    getForegroundLayout: () => layout,
    setForegroundLayout: (lang) => { calls.layoutSet.push(lang); layout = lang; return true; },
    isCapsLockOn: () => caps,
    toggleCapsLock: () => { calls.capsToggles++; caps = !caps; },
    sendUnicodeText: (t) => { calls.typed += t; },
    sendBackspaces: (n) => { calls.backspaces += n; },
    sendCtrlCombo: () => {},
    VK: {}
  };
}

function makeFakeSettings(overrides = {}) {
  const data = { autocorrectEnabled: true, primaryLang: 'he', acWordState: {}, ...overrides };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    on: () => {}
  };
}

function typeWord(engine, word) {
  engine._syncWindow();
  engine.lastKeyTime = Date.now();
  for (const ch of word) engine._appendChar(ch);
  engine._appendChar(' ');
  engine.evaluate();
}

test('engine: fixes wrong-layout word and switches keyboard to Hebrew', () => {
  const native = makeFakeNative({ layout: 'en', caps: false });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });
  const events = [];
  engine.on('corrected', (e) => events.push(e));

  typeWord(engine, 'akuo');

  assert.strictEqual(native.calls.backspaces, 5); // 'akuo' + trailing space
  assert.strictEqual(native.calls.typed, 'שלום ');
  assert.deepStrictEqual(native.calls.layoutSet, ['he']);
  assert.strictEqual(native.calls.capsToggles, 0);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].converted, 'שלום');
  assert.strictEqual(events[0].layoutSwitched, true);
});

test('engine: CapsLock slip — turns CapsLock off, keeps already-correct layout', () => {
  const native = makeFakeNative({ layout: 'he', caps: true });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });
  const events = [];
  engine.on('corrected', (e) => events.push(e));

  typeWord(engine, 'AKUO'); // what CapsLock on the Hebrew layout puts on screen

  assert.strictEqual(native.calls.capsToggles, 1, 'CapsLock must be toggled off');
  assert.deepStrictEqual(native.calls.layoutSet, [], 'layout already Hebrew — must not switch');
  assert.strictEqual(native.calls.typed, 'שלום ');
  assert.strictEqual(events[0].capsFixed, true);
  assert.strictEqual(events[0].layoutSwitched, false);
});

test('engine: CapsLock slip on wrong layout — caps off AND layout switched', () => {
  const native = makeFakeNative({ layout: 'en', caps: true });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });

  typeWord(engine, 'AKUO');

  assert.strictEqual(native.calls.capsToggles, 1);
  assert.deepStrictEqual(native.calls.layoutSet, ['he']);
});

test('engine: revert restores original text, layout and CapsLock', () => {
  const native = makeFakeNative({ layout: 'en', caps: true });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });

  typeWord(engine, 'AKUO');
  native.calls.typed = '';
  native.calls.backspaces = 0;

  const ok = engine.revertLastFix();
  assert.strictEqual(ok, true);
  assert.strictEqual(native.calls.backspaces, 5); // 'שלום' + space
  assert.strictEqual(native.calls.typed, 'AKUO ');
  assert.strictEqual(native.calls.capsToggles, 2); // back on
  assert.deepStrictEqual(native.calls.layoutSet, ['he', 'en']); // switched back
  assert.strictEqual(engine.lastFix, null);
});

test('engine: rejection suppresses the same word afterwards', () => {
  const native = makeFakeNative({ layout: 'en' });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });

  typeWord(engine, 'akuo');
  engine.revertLastFix();

  native.calls.typed = '';
  engine.cooldownUntil = 0; // skip the 30s cooldown for the test
  engine.resetRun();
  typeWord(engine, 'akuo');
  assert.strictEqual(native.calls.typed, '', 'suppressed word must not be re-corrected');
});

test('engine: correct words build confidence that blocks a following fix', () => {
  const native = makeFakeNative({ layout: 'he' });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });

  typeWord(engine, 'שלום'); // correct Hebrew → confidence 1
  typeWord(engine, 'יקךךם'); // would be wrong/he2en, but confidence blocks it
  assert.strictEqual(native.calls.typed, '');
});

test('engine: does not fire on a word the dictionaries do not know', () => {
  const native = makeFakeNative({ layout: 'en' });
  const engine = new AutocorrectEngine({ native, settings: makeFakeSettings() });
  typeWord(engine, 'xkcd');
  assert.strictEqual(native.calls.typed, '');
});
