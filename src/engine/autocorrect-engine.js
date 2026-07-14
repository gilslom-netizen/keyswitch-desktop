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
// If we are processing a key event more than this long after it physically
// happened (event-loop lag: GC pause, busy main process), the user may have
// typed MORE keys that are already on screen but not yet delivered to us —
// injecting a correction now would erase the wrong characters. Detection is
// skipped for that word instead (a missed correction is harmless; a corrupted
// line is not).
const MAX_EVENT_LAG_MS = 150;

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
    this._injectGuard = null;
    // Calibration for _eventLag(): minimum observed skew between our clock
    // and the hook thread's event timestamps (which use an arbitrary base —
    // milliseconds since boot on Windows).
    this._timeSkew = null;

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

  // How late are we processing this hook event, in ms? The hook thread stamps
  // events with its own clock (arbitrary base), so the offset to Date.now()
  // is unknown — but it is CONSTANT, and the smallest offset we ever observe
  // is the zero-lag baseline. Anything above that baseline is genuine
  // processing delay. Recalibrates itself if the clocks jump apart (system
  // suspend/resume, tick-counter wrap).
  _eventLag(e) {
    if (!e || typeof e.time !== 'number' || !isFinite(e.time) || e.time <= 0) return 0;
    const skew = Date.now() - e.time;
    if (this._timeSkew === null || skew < this._timeSkew ||
        Math.abs(skew - this._timeSkew) > 10 * 60 * 1000) {
      this._timeSkew = skew;
    }
    return skew - this._timeSkew;
  }

  // A hook callback must never throw into uiohook's native dispatcher — an
  // uncaught exception there can take down the whole hook (or the process).
  // The real handlers live in _handleKeydown/_handleMousedown below.
  _onKeydown(e) {
    try { this._handleKeydown(e); } catch (err) {
      console.error('[KeySwitch] keydown handler failed:', err);
    }
  }

  _onMousedown(e) {
    try { this._handleMousedown(e); } catch (err) {
      console.error('[KeySwitch] mouse handler failed:', err);
    }
  }

  _handleMousedown(e) {
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

  _handleKeydown(e) {
    const now = Date.now();
    const lag = this._eventLag(e);
    // Consume the hook echoes of OUR OWN injected replacement first. The old
    // approach ("ignore everything for 600ms") also swallowed REAL keystrokes
    // typed right after a correction, silently desyncing the buffer from the
    // screen. Only events that can belong to the injected batch are skipped:
    //  * keycode 0 — how the hook reports KEYEVENTF_UNICODE/VK_PACKET events;
    //    physical keyboards never produce it, so a time window is enough.
    //  * Backspace — but only as many as the batch actually contained. A
    //    REAL Backspace pressed right after a correction (the natural "undo
    //    that!" reflex) is processed normally once the echoes are consumed,
    //    instead of being silently swallowed for the whole guard window.
    // Anything else during the window is a genuine keystroke — and because
    // the replacement is a single atomic SendInput batch, that keystroke
    // landed AFTER the corrected text on screen, so processing it normally
    // keeps the buffer model correct.
    if (this._injectGuard) {
      const g = this._injectGuard;
      if (now > g.until) this._injectGuard = null;
      else if (e.keycode === keymap.UiohookKey.Backspace) {
        if (g.backspaces > 0) { g.backspaces--; return; }
        // echoes exhausted — this Backspace is the user's, fall through
      } else if (g.codes.has(e.keycode)) return;
    }
    if (!this.enabled) return;
    if (keymap.MODIFIER_KEYS.has(e.keycode)) return;

    this._syncWindow();
    if (now - this.lastKeyTime > FRESH_GAP) this.resetRun();
    this.lastKeyTime = now;

    // Shortcuts select/paste/undo/jump — the run model no longer matches the
    // screen, so drop it (same rule as the extension's live session).
    if (e.ctrlKey || e.metaKey || e.altKey) { this.resetRun(); return; }

    if (e.keycode === keymap.UiohookKey.Escape) {
      if (this.lastFix) {
        // A stale Escape means more (undelivered) keys may already be on
        // screen — reverting now would erase the wrong characters. Keep the
        // fix tracked; pressing Escape again (a fresh event) will revert.
        if (lag <= MAX_EVENT_LAG_MS) this.revertLastFix();
      } else {
        this.resetRun();
      }
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
      // safe trigger. Evaluation happens right here at space-KEYDOWN: by the
      // time this async hook callback runs in JS, the OS long since delivered
      // the physical space to the focused app, and our injected replacement is
      // queued after any already-pending input anyway. Evaluating at keyup
      // (the previous design) opened a ~50-100ms window in which a fast
      // typist's next letter entered the buffer BEFORE evaluation — the word
      // extractor then saw that letter as the "last word" and the real mistake
      // was silently skipped (missed corrections during fast typing).
      //
      // The lag gate is the "kept typing during detection" protection: when
      // this space is being processed late, keys typed after it may already
      // be on screen but not yet delivered to us, and a correction computed
      // from our (older) model would erase the wrong characters. Skip this
      // word; the buffer itself stays in sync because the pending events are
      // still delivered in order.
      if (boundary === ' ') {
        this._appendChar(' ');
        if (lag <= MAX_EVENT_LAG_MS) {
          try { this.evaluate(); } catch (err) { console.error('[KeySwitch] evaluate failed:', err); }
        }
      } else {
        this.resetRun();
      }
      return;
    }

    const layout = this.native.getForegroundLayout();
    // A third layout (Arabic, Russian, ...) — we can't model what's on screen,
    // and "correcting" text typed in it would corrupt it. Stay out of the way
    // until the user is back on Hebrew/English.
    if (layout !== 'he' && layout !== 'en') { this.buffer = ''; return; }
    const caps = this.native.isCapsLockOn();
    const ch = keymap.keyToChar(e.keycode, layout, !!e.shiftKey, caps);
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

  // Evaluation moved to space-KEYDOWN (see _onKeydown); the keyup listener is
  // kept only so uiohook keeps a consistent handler set — nothing to do here.
  _onKeyup() {}

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
  // Arm the guard covering the hook echoes of a SendInput batch we're about to
  // emit. keycode 0 (how libuiohook reports KEYEVENTF_UNICODE/VK_PACKET
  // characters) is ignored for a short window — physical keyboards never
  // produce it. Backspace echoes are counted exactly: only as many as the
  // batch contains are swallowed, so a REAL Backspace pressed right after a
  // correction is processed normally instead of desyncing the buffer.
  // Any other key is a genuine keystroke and is processed normally — so
  // typing during a correction no longer gets silently swallowed.
  _armInjectGuard(backspaceCount) {
    const until = Date.now() + INJECT_GUARD_MS;
    this.ignoreUntil = until; // also blocks the (irrelevant) mouse path
    this._injectGuard = {
      until,
      backspaces: (typeof backspaceCount === 'number') ? backspaceCount : Infinity,
      codes: new Set([0])
    };
  }

  _disarmInjectGuard() {
    this._injectGuard = null;
    this.ignoreUntil = 0;
  }

  _applyFix(fix) {
    const { runStart, runOriginal, runCore, runTrail, runConverted, decision, word, capsOn } = fix;
    const targetLang = decision.direction === 'en2he' ? 'he' : 'en';
    const prevLayout = this.native.getForegroundLayout();

    this._armInjectGuard(runOriginal.length);

    // 1. Replace the wrong run in ONE atomic SendInput batch (erase + retype).
    //    A single batch can't be interleaved with real user input, so a key
    //    the user presses mid-correction lands cleanly after the whole
    //    replacement instead of in the middle of it. Unicode injection is
    //    layout-independent, so ordering vs. the layout switch is irrelevant.
    const injected = this.native.replaceText(runOriginal.length, runConverted + runTrail);
    if (injected === false) {
      // SendInput was blocked (elevated window, secure desktop, UIPI):
      // NOTHING reached the screen, so record nothing, notify nothing, and
      // drop the guard immediately so no real keystroke gets eaten as an
      // "echo" of a batch that never happened.
      this._disarmInjectGuard();
      this.resetRun();
      return;
    }

    // 2. CapsLock-first policy (per spec): a caps slip is fixed by turning
    //    CapsLock off, and only then do we check whether the layout is wrong.
    let capsFixed = false;
    if (capsOn) {
      capsFixed = this.native.toggleCapsLock() !== false;
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

    const eraseLen = fix.converted.length + fix.typedAfter.length;
    this._armInjectGuard(eraseLen);
    // Same atomic erase+retype as _applyFix, so a keystroke during the revert
    // can't land in the middle of it.
    const injected = this.native.replaceText(eraseLen, fix.original + fix.typedAfter);
    if (injected === false) {
      // Injection blocked — the corrected text is still on screen. Keep the
      // fix tracked (a later Escape/click can retry) and swallow no echoes.
      this._disarmInjectGuard();
      return false;
    }

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
