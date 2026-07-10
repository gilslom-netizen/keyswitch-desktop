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
const crypto = require('crypto');
const { convertFullText } = require('./shared_logic');
const dict = require('./dictionaries');
const keymap = require('./keymap');

// Rejected words are tracked so the engine stops re-suggesting the same
// false-positive, but the word itself may be sensitive (it's arbitrary text
// the user typed — potentially part of a password mistyped in the wrong
// layout). It must never sit in %APPDATA%\KeySwitch\settings.json as
// recoverable plaintext, so only a one-way hash of it is ever persisted —
// this is an internal tracking key, not a secret we need to decrypt later,
// so a hash (not encryption/safeStorage) is the right tool here.
function hashWord(word) {
  return crypto.createHash('sha256').update(word.toLowerCase()).digest('hex');
}

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

    // Screen-space rectangle of the currently visible toast window, if any, so
    // clicks on it don't reset the run (set by main.js). null = no protection.
    this.protectedRect = null;

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
    // Clear the per-window "confidence" accumulator too. It tracks how many
    // correct words the user typed in a row so a genuine word isn't mistaken
    // for a layout error mid-burst — but it must NOT survive across typing
    // bursts. On surfaces with a stable window handle (e.g. the Windows search
    // box), leaving a field and returning keeps the same windowId, so without
    // this the leftover confidence could silently suppress the FIRST mistake
    // after you come back — the "sometimes it stops auto-correcting when I
    // return to the field" bug. A fresh burst must start with a clean slate so
    // detection is always live.
    this.confidence.clear();
    this._endFixTracking();
  }

  _endFixTracking() {
    this.lastFix = null;
    this.emit('fix-tracking-ended');
  }

  _onMousedown(e) {
    if (Date.now() < this.ignoreUntil) return;
    // A click INSIDE our own toast window (e.g. the "החזר טקסט מקורי ועצור"
    // button) must not tear down the run — otherwise the global mouse hook
    // would clear lastFix before the button's own handler runs, and the revert
    // would find nothing to undo. main.js keeps protectedRect in sync with the
    // visible toast's screen bounds.
    const r = this.protectedRect;
    if (r && e && typeof e.x === 'number' && typeof e.y === 'number' &&
        e.x >= r.x && e.x <= r.x + r.width && e.y >= r.y && e.y <= r.y + r.height) {
      return;
    }
    this.resetRun();
  }

  _syncWindow() {
    const id = this.native.getForegroundWindowId();
    if (id !== this.windowId) {
      this.windowId = id;
      this.resetRun();
      // A different window is a fresh context: clear the anti-nag state left
      // over from rejections in the previous app/field, so detection is
      // immediately live here. Without this, on a long-running tray session
      // these counters accumulate forever and the engine grows over-quiet.
      // (These are intentionally NOT cleared in resetRun(), which also fires on
      // mere clicks — that would defeat the cooldown right after a revert in
      // the same field.)
      this.cooldownUntil = 0;
      this.sessionRejections = 0;
      this.hardOff = null;
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
  // (cooldown + per-word suppression, keyed by hash — see hashWord above).
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
  // REJECTION BOOKKEEPING (cooldown, hard-off, per-word suppression keyed by
  // a one-way hash — never the literal word; see hashWord above)
  // ---------------------------------------------------------------------------
  _registerRejection(word) {
    if (!word) return;
    const now = Date.now();
    this.cooldownUntil = now + REJECT_COOLDOWN_MS;
    this.sessionRejections += 1;
    if (this.sessionRejections >= 3) {
      this.hardOff = { windowId: this.windowId, until: now + HARD_OFF_MS };
    }
    const key = hashWord(word);
    const st = this.wordState[key] || { count: 0, last: 0 };
    st.count += 1;
    st.last = now;
    this.wordState[key] = st;
    this.settings.set('acWordState', this.wordState);
  }

  _isSuppressed(word) {
    const st = this.wordState[hashWord(word)];
    if (!st) return false;
    if (st.count >= 3) return true;
    return (Date.now() - st.last < WORD_SUPPRESS_MS);
  }
}

module.exports = { AutocorrectEngine, computeRunStart };
