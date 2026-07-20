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
// Apparent lag that persists longer than this is not lag at all. Genuine
// event-loop lag is over the moment we are running again — and we ARE running
// (we're processing the event) — so a stale burst clears within milliseconds.
// A "delay" that every event keeps reporting for seconds on end means the two
// clocks moved apart: Date.now() is the NTP-disciplined wall clock (steps on
// time sync / resume from sleep) while hook timestamps come from the tick
// counter, and the two also drift by seconds per day on a long tray session.
// Without this recalibration a single forward wall-clock step >150ms would
// leave every future event looking "late" — and detection silently dead until
// the app restarts (the "sometimes it just stops correcting" bug).
const LAG_RECAL_MS = 2000;

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
    // milliseconds since boot on Windows), plus the start time of the current
    // streak of above-gate readings (see LAG_RECAL_MS).
    this._timeSkew = null;
    this._lagSince = 0;

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
  // is unknown — the smallest offset observed so far is the zero-lag
  // baseline, and anything above it is processing delay. But the two clocks
  // are NOT locked to each other (wall-clock time sync, suspend/resume, tick
  // drift), so the baseline must never be trusted forever: a reading below
  // the baseline adopts it immediately, and a streak of above-gate readings
  // that outlives LAG_RECAL_MS proves the clocks moved apart — real lag
  // cannot persist, because processing this event means the loop is live —
  // so the baseline is re-anchored instead of gating detection forever.
  _eventLag(e) {
    if (!e || typeof e.time !== 'number' || !isFinite(e.time) || e.time <= 0) return 0;
    const now = Date.now();
    const skew = now - e.time;
    if (this._timeSkew === null || skew <= this._timeSkew) {
      this._timeSkew = skew;
      this._lagSince = 0;
      return 0;
    }
    const lag = skew - this._timeSkew;
    if (lag <= MAX_EVENT_LAG_MS) {
      this._lagSince = 0;
      return lag;
    }
    if (!this._lagSince) {
      this._lagSince = now;
    } else if (now - this._lagSince > LAG_RECAL_MS) {
      this._timeSkew = skew;
      this._lagSince = 0;
      return 0;
    }
    return lag;
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
    // A click ordered ahead of our in-flight batch moved the caret before the
    // replacement landed — the screen no longer matches the model, and a
    // repair must never be injected over an unknown caret position. Poison
    // the guard; its completion then drops the run instead of repairing.
    const g = this._injectGuard;
    if (g && Date.now() <= g.until) { g.poisoned = true; return; }
    if (Date.now() < this.ignoreUntil) return;
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
    // Consume the hook echoes of OUR OWN injected replacement first. The hook
    // delivers every input event in true screen order, and a SendInput batch
    // is contiguous in that stream — so the echo block is an exact fence:
    //  * Backspace and keycode-0 (KEYEVENTF_UNICODE/VK_PACKET — physical
    //    keyboards never produce it) echoes are counted precisely against
    //    what the batch contained, and the guard disarms the moment the last
    //    echo is consumed.
    //  * A PHYSICAL key seen while echoes are still pending was pressed
    //    BEFORE the batch: it reached the screen first, and the batch's
    //    backspaces erased IT instead of the tail of the mistyped run —
    //    leaving the run's first character(s) behind. Processing such a key
    //    normally (the old behavior — it assumed every key during the guard
    //    landed AFTER the replacement) silently desynced the buffer from the
    //    screen, and every later correction then erased the wrong characters:
    //    the "leftover mistakes / duplicated corrections while typing through
    //    an auto-fix" bug. Raced keys are collected instead, and once the
    //    echoes complete the fix is REPAIRED in one more atomic batch (see
    //    _completeInjectGuard).
    //  * A key that reached the screen mid-stream or moved the caret (echo
    //    miscount, shortcut, nav key, mouse click) poisons the guard: the
    //    screen is unknowable, so the run is dropped rather than guessed at.
    if (this._injectGuard) {
      const g = this._injectGuard;
      if (now > g.until) {
        // Echoes never (fully) arrived — event-loop stall or another hook
        // interfered. The screen can no longer be trusted: drop the run and
        // process this event as fresh input.
        this._injectGuard = null;
        this.ignoreUntil = 0;
        this.resetRun();
      } else if (e.keycode === keymap.UiohookKey.Backspace && g.backspaces > 0) {
        if (g.unicode !== g.uniTotal) g.poisoned = true; // out-of-order echo — count is off
        g.backspaces--;
        if (g.backspaces === 0 && g.unicode === 0) this._completeInjectGuard();
        return;
      } else if (e.keycode === 0) {
        if (g.unicode > 0) {
          if (g.backspaces > 0) g.poisoned = true; // unicode before erases done — count is off
          g.unicode--;
          if (g.backspaces === 0 && g.unicode === 0) this._completeInjectGuard();
        }
        return; // never physical — swallow regardless
      } else if (keymap.MODIFIER_KEYS.has(e.keycode)) {
        return; // produces no screen character — no ordering to repair
      } else {
        if (g.backspaces !== g.bsTotal || e.ctrlKey || e.metaKey || e.altKey) {
          g.poisoned = true; // arrived mid-echo-stream / a shortcut fired — unknowable screen
        } else {
          g.strays.push({ keycode: e.keycode, shiftKey: !!e.shiftKey });
        }
        return;
      }
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
  // Arm the guard covering the hook echoes of a SendInput batch we're about
  // to emit. Both echo kinds are counted exactly — `preText` is what the
  // batch erases (one Backspace echo per character) and `typed` is what it
  // types (one keycode-0 echo per UTF-16 unit) — so the guard knows precisely
  // when the batch has fully echoed back and disarms on the spot. Until then,
  // any physical key that arrives raced AHEAD of the batch (hook order is
  // screen order) and is collected for the repair in _completeInjectGuard.
  _armInjectGuard({ preText, typed, targetLayout, trackFix }) {
    const until = Date.now() + INJECT_GUARD_MS;
    this.ignoreUntil = until; // also blocks the mouse path while echoes are pending
    this._injectGuard = {
      until,
      bsTotal: preText.length,
      backspaces: preText.length,
      uniTotal: typed.length,
      unicode: typed.length,
      preText,
      typed,
      targetLayout: targetLayout || null,
      trackFix: !!trackFix,
      strays: [],
      poisoned: false
    };
  }

  _disarmInjectGuard() {
    this._injectGuard = null;
    this.ignoreUntil = 0;
  }

  // Every echo of the last injected batch has been consumed. If physical
  // keystrokes raced AHEAD of that batch, they reached the screen first and
  // the batch's backspaces erased them instead of the end of `preText` — the
  // screen now shows: …prefix + preText[0..k) + typed. Repair it with one
  // more atomic batch: erase those k leftover characters plus the typed text,
  // then retype the text followed by the raced keystrokes mapped to the
  // layout the user meant. The repair is guarded exactly like the original
  // batch, so a keystroke racing the repair is handled recursively.
  _completeInjectGuard() {
    const g = this._injectGuard;
    this._injectGuard = null;
    this.ignoreUntil = 0;
    if (!g.strays.length && !g.poisoned) return;
    if (g.poisoned || !g.targetLayout || g.strays.length > g.preText.length) {
      this.resetRun();
      return;
    }
    const caps = this.native.isCapsLockOn();
    let strayText = '';
    for (const s of g.strays) {
      const ch = (s.keycode === keymap.UiohookKey.Space)
        ? ' '
        : keymap.keyToChar(s.keycode, g.targetLayout, s.shiftKey, caps);
      // Backspace/nav/Enter/… changed the screen in a way we can't model —
      // drop the run rather than inject over an unknown state.
      if (ch == null) { this.resetRun(); return; }
      strayText += ch;
    }
    const preText = g.preText.slice(0, g.strays.length) + g.typed;
    const typed = g.typed + strayText;
    this._armInjectGuard({ preText, typed, targetLayout: g.targetLayout, trackFix: g.trackFix });
    const injected = this.native.replaceText(preText.length, typed);
    if (injected === false) {
      this._disarmInjectGuard();
      this.resetRun();
      return;
    }
    this.buffer += strayText;
    if (this.buffer.length > 2000) this.buffer = this.buffer.slice(-1000);
    if (g.trackFix && this.lastFix) this.lastFix.typedAfter += strayText;
  }

  _applyFix(fix) {
    const { runStart, runOriginal, runCore, runTrail, runConverted, decision, word, capsOn } = fix;
    const targetLang = decision.direction === 'en2he' ? 'he' : 'en';
    const prevLayout = this.native.getForegroundLayout();

    this._armInjectGuard({
      preText: runOriginal,
      typed: runConverted + runTrail,
      targetLayout: targetLang,
      trackFix: true
    });

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
    this._armInjectGuard({
      preText: fix.converted + fix.typedAfter,
      typed: fix.original + fix.typedAfter,
      targetLayout: (fix.prevLayout === 'he' || fix.prevLayout === 'en') ? fix.prevLayout : null,
      trackFix: false
    });
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
