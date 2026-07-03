// autocorrect-engine.js - KeySwitch Desktop
// =============================================================================
// System-wide automatic wrong-keyboard-layout detection.
//
// Ported from the browser extension's autocorrect.js with one deliberate
// difference: after fixing the mistyped text, the desktop app SWITCHES THE
// ACTUAL KEYBOARD LAYOUT of the focused window instead of live-remapping every
// subsequent keystroke. CapsLock slips are handled per spec:
//   1. If CapsLock was on when the mistake was detected — turn CapsLock off.
//   2. Then check whether the active layout already matches the language the
//      user meant; switch it only if it doesn't.
// The mistyped text itself is erased with synthetic Backspaces and retyped
// with layout-independent Unicode key events, so this works in any app —
// Word, Excel, blocked Chrome pages, Google Docs/canvas pages, terminals.
//
// Because we cannot read the focused app's text, the engine reconstructs the
// current "fresh typing run" from the global keyboard hook (see keymap.js).
// The run resets on focus change, mouse click, navigation keys, shortcuts and
// typing gaps — the same freshness model as the extension's FRESH_GAP logic.
// =============================================================================
'use strict';

const { EventEmitter } = require('events');
const { convertFullText } = require('./shared_logic');
const dict = require('./dictionaries');
const keymap = require('./keymap');

const FRESH_GAP = 15000;
const REJECT_COOLDOWN_MS = 30 * 1000;
const WORD_SUPPRESS_MS = 30 * 60 * 1000;
const HARD_OFF_MS = 5 * 60 * 1000;
const FIX_TRACK_MS = 30 * 1000;
const INJECT_GUARD_MS = 600;

const isWordChar = (c) => c != null && /[A-Za-z֐-׿0-9']/.test(c);
const isBoundaryChar = (c) => c != null && !isWordChar(c);

// Where should the re-converted block start? Identical semantics to the
// extension's computeRunStart: never re-flip a word the user already typed
// correctly in the opposite script.
function computeRunStart(str, freshStart, wordEnd, direction) {
  const stopOnHeb = (direction === 'en2he');
  let cut = freshStart;
  let i = freshStart;
  while (i < wordEnd) {
    while (i < wordEnd && isBoundaryChar(str[i])) i++;
    if (i >= wordEnd) break;
    const s = i;
    while (i < wordEnd && isWordChar(str[i])) i++;
    const w = str.slice(s, i);
    const isOpposite = stopOnHeb ? /[֐-׿]/.test(w) : /[A-Za-z]/.test(w);
    if (isOpposite) cut = i;
  }
  let rs = cut;
  while (rs < wordEnd && /\s/.test(str[rs])) rs++;
  return rs;
}

class AutocorrectEngine extends EventEmitter {
  constructor({ native, settings }) {
    super();
    this.native = native;
    this.settings = settings;
    this.enabled = settings.get('autocorrectEnabled') !== false;
    dict.applyPrimaryLang(settings.get('primaryLang') || 'he');

    this.buffer = '';
    this.windowId = null;
    this.lastKeyTime = 0;
    this.ignoreUntil = 0;

    this.wordState = settings.get('acWordState') || {};
    this.cooldownUntil = 0;
    this.sessionRejections = 0;
    this.hardOff = null; // { windowId, until }
    this.confidence = new Map(); // windowId -> { window: [], lang }
    this.lastFix = null;

    this.uiohook = null;
    this._onKeydown = this._onKeydown.bind(this);
    this._onKeyup = this._onKeyup.bind(this);
    this._onMousedown = this._onMousedown.bind(this);

    settings.on('change', (key, value) => {
      if (key === 'autocorrectEnabled') this.enabled = value !== false;
      if (key === 'primaryLang') dict.applyPrimaryLang(value);
      if (key === 'acWordState' && value) this.wordState = value;
    });
  }

  start() {
    if (!this.native.isSupported) return false;
    try {
      const { uIOhook } = require('uiohook-napi');
      this.uiohook = uIOhook;
      this.uiohook.on('keydown', this._onKeydown);
      this.uiohook.on('keyup', this._onKeyup);
      this.uiohook.on('mousedown', this._onMousedown);
      this.uiohook.start();
      return true;
    } catch (e) {
      console.error('[KeySwitch] keyboard hook failed to start:', e);
      return false;
    }
  }

  stop() {
    if (!this.uiohook) return;
    try {
      this.uiohook.off('keydown', this._onKeydown);
      this.uiohook.off('keyup', this._onKeyup);
      this.uiohook.off('mousedown', this._onMousedown);
      this.uiohook.stop();
    } catch (e) {}
    this.uiohook = null;
  }

  resetRun() {
    this.buffer = '';
    this._endFixTracking();
  }

  _endFixTracking() {
    this.lastFix = null;
    this.emit('fix-tracking-ended');
  }

  _onMousedown() {
    if (Date.now() < this.ignoreUntil) return;
    this.resetRun();
  }

  _syncWindow() {
    const id = this.native.getForegroundWindowId();
    if (id !== this.windowId) {
      this.windowId = id;
      this.resetRun();
      return true;
    }
    return false;
  }

  _onKeydown(e) {
    const now = Date.now();
    if (now < this.ignoreUntil) return;
    if (!this.enabled) return;
    if (keymap.MODIFIER_KEYS.has(e.keycode)) return;

    this._syncWindow();
    if (now - this.lastKeyTime > FRESH_GAP) this.resetRun();
    this.lastKeyTime = now;

    // Shortcuts select/paste/undo/jump — the run model no longer matches the
    // screen, so drop it (same rule as the extension's live session).
    if (e.ctrlKey || e.metaKey || e.altKey) { this.resetRun(); return; }

    if (e.keycode === keymap.UiohookKey.Escape) {
      if (this.lastFix) this.revertLastFix();
      else this.resetRun();
      return;
    }
    if (e.keycode === keymap.UiohookKey.Backspace) {
      if (this.lastFix) {
        if (this.lastFix.typedAfter.length) this.lastFix.typedAfter = this.lastFix.typedAfter.slice(0, -1);
        else this._endFixTracking(); // deleting into the fixed text — stop tracking
      }
      this.buffer = this.buffer.slice(0, -1);
      return;
    }
    if (keymap.NAV_KEYS.has(e.keycode)) { this.resetRun(); return; }

    const boundary = keymap.boundaryChar(e.keycode);
    if (boundary != null) {
      // Enter/Tab often submit a message or move focus — the text may be gone
      // by the time we could fix it, so they only close the run. Space is the
      // safe trigger; evaluation happens on its keyup (see _onKeyup), once the
      // space character has definitely reached the target app.
      if (boundary === ' ') {
        this._appendChar(' ');
        this._pendingEvaluate = true;
      } else {
        this.resetRun();
      }
      return;
    }

    const layout = this.native.getForegroundLayout();
    const caps = this.native.isCapsLockOn();
    const ch = keymap.keyToChar(e.keycode, layout === 'he' ? 'he' : 'en', !!e.shiftKey, caps);
    if (ch == null) return;
    this._appendChar(ch);
  }

  _appendChar(ch) {
    this.buffer += ch;
    if (this.buffer.length > 2000) this.buffer = this.buffer.slice(-1000);
    if (this.lastFix) {
      if (Date.now() - this.lastFix.time > FIX_TRACK_MS) this._endFixTracking();
      else this.lastFix.typedAfter += ch;
    }
  }

  _onKeyup(e) {
    if (Date.now() < this.ignoreUntil) return;
    if (!this._pendingEvaluate || e.keycode !== keymap.UiohookKey.Space) return;
    this._pendingEvaluate = false;
    try { this.evaluate(); } catch (err) { console.error('[KeySwitch] evaluate failed:', err); }
  }

  // ---------------------------------------------------------------------------
  // DETECTION
  // ---------------------------------------------------------------------------
  evaluate() {
    if (!this.enabled) return;
    const now = Date.now();
    if (now < this.cooldownUntil) return;
    if (this.hardOff && this.hardOff.windowId === this.windowId && now < this.hardOff.until) return;

    const buf = this.buffer;
    const coreEnd = buf.replace(/\s+$/, '').length;
    if (coreEnd === 0) return;
    let start = coreEnd;
    while (start > 0 && isWordChar(buf[start - 1])) start--;
    if (start >= coreEnd) return;
    const word = buf.slice(start, coreEnd);
    if (this._isSuppressed(word)) return;

    const capsOn = this.native.isCapsLockOn();
    const decision = this._decideCorrection(word, capsOn);
    if (!decision) return;

    const runStart = computeRunStart(buf, 0, coreEnd, decision.direction);
    const runOriginal = buf.slice(runStart);
    const trailMatch = runOriginal.match(/\s+$/);
    const runTrail = trailMatch ? trailMatch[0] : '';
    const runCore = runTrail ? runOriginal.slice(0, -runTrail.length) : runOriginal;
    const runConverted = convertFullText(runCore, decision.direction);
    if (!runCore || runConverted === runCore) return;

    this._applyFix({ runStart, runOriginal, runCore, runTrail, runConverted, decision, word, capsOn });
  }

  _decideCorrection(word, capsActive) {
    const cls = dict.classify(word, capsActive);
    if (cls.kind === 'unknown') return null;

    let vst = this.confidence.get(this.windowId);
    if (!vst) { vst = { window: [], lang: null }; this.confidence.set(this.windowId, vst); }
    if (this.confidence.size > 50) this.confidence.clear();

    if (cls.kind === 'correct') {
      if (vst.lang && cls.lang !== vst.lang) vst.window = [];
      vst.lang = cls.lang;
      vst.window.push(1);
      if (vst.window.length > 10) vst.window.shift();
      return null;
    }

    const confidence = vst.window.reduce((s, v) => s + v, 0);
    vst.window.push(0);
    if (vst.window.length > 10) vst.window.shift();
    return confidence > 0 ? null : { direction: cls.direction };
  }

  // ---------------------------------------------------------------------------
  // FIX: erase the wrong run, retype it converted, then align the OS state —
  // CapsLock off first if it was the culprit, keyboard layout switched only if
  // it still doesn't match the language the user actually meant.
  // ---------------------------------------------------------------------------
  _applyFix(fix) {
    const { runStart, runOriginal, runCore, runTrail, runConverted, decision, word, capsOn } = fix;
    const targetLang = decision.direction === 'en2he' ? 'he' : 'en';
    const prevLayout = this.native.getForegroundLayout();

    this.ignoreUntil = Date.now() + INJECT_GUARD_MS;

    // 1. Replace the text (Unicode injection is layout-independent, so the
    //    order relative to the layout switch doesn't matter for correctness).
    this.native.sendBackspaces(runOriginal.length);
    this.native.sendUnicodeText(runConverted + runTrail);

    // 2. CapsLock-first policy (per spec): a caps slip is fixed by turning
    //    CapsLock off, and only then do we check whether the layout is wrong.
    let capsFixed = false;
    if (capsOn) {
      this.native.toggleCapsLock();
      capsFixed = true;
    }
    let layoutSwitched = false;
    if (prevLayout !== targetLang) {
      layoutSwitched = this.native.setForegroundLayout(targetLang);
    }

    this.buffer = this.buffer.slice(0, runStart) + runConverted + runTrail;
    this.lastFix = {
      time: Date.now(),
      windowId: this.windowId,
      runStart,
      original: runOriginal,
      converted: runConverted + runTrail,
      typedAfter: '',
      triggerWord: word,
      capsFixed,
      layoutSwitched,
      prevLayout,
      targetLang
    };

    const wordCount = runConverted.trim() ? runConverted.trim().split(/\s+/).length : 0;
    this.emit('corrected', {
      original: runCore,
      converted: runConverted,
      direction: decision.direction,
      capsFixed,
      layoutSwitched,
      targetLang,
      wordCount
    });
  }

  // "החזר טקסט מקורי ועצור" — restore the exact original keystrokes, put
  // CapsLock and the layout back the way they were, and register the rejection
  // (cooldown + per-word suppression, like the extension).
  revertLastFix() {
    const fix = this.lastFix;
    if (!fix) return false;
    if (fix.windowId !== this.native.getForegroundWindowId()) { this._endFixTracking(); return false; }

    this.ignoreUntil = Date.now() + INJECT_GUARD_MS;
    const eraseLen = fix.converted.length + fix.typedAfter.length;
    this.native.sendBackspaces(eraseLen);
    this.native.sendUnicodeText(fix.original + fix.typedAfter);

    if (fix.capsFixed) this.native.toggleCapsLock();
    if (fix.layoutSwitched && (fix.prevLayout === 'he' || fix.prevLayout === 'en')) {
      this.native.setForegroundLayout(fix.prevLayout);
    }

    this.buffer = this.buffer.slice(0, fix.runStart) + fix.original + fix.typedAfter;
    this._registerRejection(fix.triggerWord || fix.original);
    this.lastFix = null;
    this.emit('reverted');
    return true;
  }

  // ---------------------------------------------------------------------------
  // REJECTION BOOKKEEPING (ported: cooldown, hard-off, per-word suppression)
  // ---------------------------------------------------------------------------
  _registerRejection(word) {
    if (!word) return;
    const now = Date.now();
    this.cooldownUntil = now + REJECT_COOLDOWN_MS;
    this.sessionRejections += 1;
    if (this.sessionRejections >= 3) {
      this.hardOff = { windowId: this.windowId, until: now + HARD_OFF_MS };
    }
    const key = word.toLowerCase();
    const st = this.wordState[key] || { count: 0, last: 0 };
    st.count += 1;
    st.last = now;
    this.wordState[key] = st;
    this.settings.set('acWordState', this.wordState);
  }

  _isSuppressed(word) {
    const st = this.wordState[word.toLowerCase()];
    if (!st) return false;
    if (st.count >= 3) return true;
    return (Date.now() - st.last < WORD_SUPPRESS_MS);
  }
}

module.exports = { AutocorrectEngine, computeRunStart };
