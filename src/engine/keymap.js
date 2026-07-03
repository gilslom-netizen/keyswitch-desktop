// keymap.js - KeySwitch Desktop
// =============================================================================
// Maps physical keys (uiohook keycodes) to the character they produce under
// each keyboard layout (English-US / Hebrew-Standard), for every shift/caps
// state. This is how the engine reconstructs "what the user sees on screen"
// without reading the target application's text.
//
// Windows Hebrew layout facts the map relies on:
//   * Unshifted alpha/punctuation keys produce the Hebrew characters
//     (same physical mapping as the extension's EN_TO_HE table).
//   * Shift+letter AND CapsLock+letter produce CAPITAL LATIN letters —
//     this is why a forgotten CapsLock on the Hebrew layout yields "AKUO"
//     instead of "שלום", and it is exactly the case the desktop app fixes by
//     turning CapsLock off instead of switching the layout.
// =============================================================================
'use strict';

// Keycode values mirrored from uiohook-napi's UiohookKey enum (libuiohook's
// stable VC_* constants). Kept as a local table — NOT required from
// uiohook-napi — so the pure-JS engine and its tests never load the native
// module (which needs a display server and real input devices).
const UiohookKey = uiohookKeycodes();
function uiohookKeycodes() {
  return {
    Backspace: 14, Tab: 15, Enter: 28, CapsLock: 58, Escape: 1, Space: 57,
    PageUp: 3657, PageDown: 3665, End: 3663, Home: 3655,
    ArrowLeft: 57419, ArrowUp: 57416, ArrowRight: 57421, ArrowDown: 57424,
    Insert: 3666, Delete: 3667,
    A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36,
    K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20,
    U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
    '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
    Semicolon: 39, Equal: 13, Comma: 51, Minus: 12, Period: 52, Slash: 53,
    Backquote: 41, BracketLeft: 26, Backslash: 43, BracketRight: 27, Quote: 40,
    Ctrl: 29, CtrlRight: 3613, Alt: 56, AltRight: 3640,
    Shift: 42, ShiftRight: 54, Meta: 3675, MetaRight: 3676,
    Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75,
    Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
    NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74,
    NumpadDecimal: 83, NumpadDivide: 3637, NumpadEnter: 3612
  };
}

const K = UiohookKey;

// [physical base char, EN shifted char, HE unshifted char]
// HE shifted/caps for letters is the CAPITAL LATIN letter (see header note).
const LETTERS = {
  [K.Q]: ['q', '/'], [K.W]: ['w', "'"], [K.E]: ['e', 'ק'], [K.R]: ['r', 'ר'],
  [K.T]: ['t', 'א'], [K.Y]: ['y', 'ט'], [K.U]: ['u', 'ו'], [K.I]: ['i', 'ן'],
  [K.O]: ['o', 'ם'], [K.P]: ['p', 'פ'], [K.A]: ['a', 'ש'], [K.S]: ['s', 'ד'],
  [K.D]: ['d', 'ג'], [K.F]: ['f', 'כ'], [K.G]: ['g', 'ע'], [K.H]: ['h', 'י'],
  [K.J]: ['j', 'ח'], [K.K]: ['k', 'ל'], [K.L]: ['l', 'ך'], [K.Z]: ['z', 'ז'],
  [K.X]: ['x', 'ס'], [K.C]: ['c', 'ב'], [K.V]: ['v', 'ה'], [K.B]: ['b', 'נ'],
  [K.N]: ['n', 'מ'], [K.M]: ['m', 'צ']
};

// [EN unshifted, EN shifted, HE unshifted, HE shifted]
const OTHERS = {
  [K['1']]: ['1', '!', '1', '!'], [K['2']]: ['2', '@', '2', '@'],
  [K['3']]: ['3', '#', '3', '#'], [K['4']]: ['4', '$', '4', '₪'],
  [K['5']]: ['5', '%', '5', '%'], [K['6']]: ['6', '^', '6', '^'],
  [K['7']]: ['7', '&', '7', '&'], [K['8']]: ['8', '*', '8', '*'],
  [K['9']]: ['9', '(', '9', ')'], [K['0']]: ['0', ')', '0', '('],
  [K.Minus]: ['-', '_', '-', '_'], [K.Equal]: ['=', '+', '=', '+'],
  [K.BracketLeft]: ['[', '{', ']', '}'], [K.BracketRight]: [']', '}', '[', '{'],
  [K.Semicolon]: [';', ':', 'ף', ':'], [K.Quote]: ["'", '"', ',', '"'],
  [K.Backquote]: ['`', '~', ';', '~'], [K.Backslash]: ['\\', '|', '\\', '|'],
  [K.Comma]: [',', '<', 'ת', '>'], [K.Period]: ['.', '>', 'ץ', '<'],
  [K.Slash]: ['/', '?', '.', '?'],
  [K.Numpad0]: ['0', '0', '0', '0'], [K.Numpad1]: ['1', '1', '1', '1'],
  [K.Numpad2]: ['2', '2', '2', '2'], [K.Numpad3]: ['3', '3', '3', '3'],
  [K.Numpad4]: ['4', '4', '4', '4'], [K.Numpad5]: ['5', '5', '5', '5'],
  [K.Numpad6]: ['6', '6', '6', '6'], [K.Numpad7]: ['7', '7', '7', '7'],
  [K.Numpad8]: ['8', '8', '8', '8'], [K.Numpad9]: ['9', '9', '9', '9'],
  [K.NumpadMultiply]: ['*', '*', '*', '*'], [K.NumpadAdd]: ['+', '+', '+', '+'],
  [K.NumpadSubtract]: ['-', '-', '-', '-'], [K.NumpadDecimal]: ['.', '.', '.', '.'],
  [K.NumpadDivide]: ['/', '/', '/', '/']
};

const BOUNDARY_KEYS = new Set([K.Space, K.Enter, K.Tab, K.NumpadEnter]);
const NAV_KEYS = new Set([
  K.ArrowLeft, K.ArrowRight, K.ArrowUp, K.ArrowDown,
  K.Home, K.End, K.PageUp, K.PageDown, K.Delete, K.Insert
]);
const MODIFIER_KEYS = new Set([
  K.Ctrl, K.CtrlRight, K.Alt, K.AltRight, K.Shift, K.ShiftRight,
  K.Meta, K.MetaRight, K.CapsLock
]);

// Resolve a physical keypress to the character it puts on screen.
//   layout: 'en' | 'he'  — active layout of the focused window
//   shift, caps: modifier state at the time of the keypress
// Returns null for keys that produce no printable character.
function keyToChar(keycode, layout, shift, caps) {
  const letter = LETTERS[keycode];
  if (letter) {
    if (layout === 'he') {
      // Hebrew layout: Shift or CapsLock yields the capital Latin letter.
      if (shift || caps) return letter[0].toUpperCase();
      return letter[1];
    }
    const upper = (shift !== caps); // shift XOR caps
    return upper ? letter[0].toUpperCase() : letter[0];
  }
  const other = OTHERS[keycode];
  if (other) {
    if (layout === 'he') return shift ? other[3] : other[2];
    return shift ? other[1] : other[0];
  }
  return null;
}

function boundaryChar(keycode) {
  if (keycode === K.Space) return ' ';
  if (keycode === K.Tab) return '\t';
  if (keycode === K.Enter || keycode === K.NumpadEnter) return '\n';
  return null;
}

module.exports = {
  UiohookKey: K,
  keyToChar,
  boundaryChar,
  BOUNDARY_KEYS,
  NAV_KEYS,
  MODIFIER_KEYS
};
