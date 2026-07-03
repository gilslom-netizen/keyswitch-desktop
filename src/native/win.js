// win.js - KeySwitch Desktop
// =============================================================================
// Thin Win32 layer (via koffi FFI). Everything the engine needs from the OS:
//   * which window is focused and which keyboard layout it uses
//   * switching that layout (WM_INPUTLANGCHANGEREQUEST) — the desktop app's
//     replacement for the extension's per-character live remapping
//   * CapsLock state + toggling it off when a caps slip is detected
//   * synthesizing keystrokes (SendInput): backspaces to erase the wrong text,
//     KEYEVENTF_UNICODE to retype the corrected text layout-independently,
//     and Ctrl+C / Ctrl+V for the manual-conversion shortcut
//
// On non-Windows platforms (development / CI) every call becomes a no-op and
// `isSupported` is false, so the pure-JS engine and UI still run.
// =============================================================================
'use strict';

const IS_WIN = process.platform === 'win32';

const VK = {
  BACK: 0x08, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, CAPITAL: 0x14,
  RETURN: 0x0D, C: 0x43, V: 0x56
};
const KEYEVENTF = { KEYUP: 0x0002, UNICODE: 0x0004 };
const WM_INPUTLANGCHANGEREQUEST = 0x0050;
const KLF_ACTIVATE = 0x00000001;
const LAYOUT_KLID = { he: '0000040D', en: '00000409' };

function makeStub() {
  return {
    isSupported: false,
    getForegroundWindowId: () => '0',
    getForegroundLayout: () => 'en',
    setForegroundLayout: () => false,
    isCapsLockOn: () => false,
    toggleCapsLock: () => {},
    sendUnicodeText: () => {},
    sendBackspaces: () => {},
    sendCtrlCombo: () => {},
    VK
  };
}

function makeWin() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  const KEYBDINPUT = koffi.struct('KS_KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uint64'
  });
  const MOUSEINPUT = koffi.struct('KS_MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32',
    time: 'uint32', dwExtraInfo: 'uint64'
  });
  const INPUT_UNION = koffi.union('KS_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
  const INPUT = koffi.struct('KS_INPUT', { type: 'uint32', u: INPUT_UNION });

  const GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void*, void*)');
  const GetKeyboardLayout = user32.func('void* __stdcall GetKeyboardLayout(uint32)');
  const GetKeyState = user32.func('int16 __stdcall GetKeyState(int32)');
  const LoadKeyboardLayoutW = user32.func('void* __stdcall LoadKeyboardLayoutW(str16, uint32)');
  const PostMessageW = user32.func('bool __stdcall PostMessageW(void*, uint32, uint64, void*)');
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32, KS_INPUT*, int32)');

  const INPUT_KEYBOARD = 1;
  const INPUT_SIZE = koffi.sizeof(INPUT);

  function keyInput(wVk, wScan, dwFlags) {
    return { type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } };
  }

  function send(inputs) {
    if (!inputs.length) return 0;
    return SendInput(inputs.length, inputs, INPUT_SIZE);
  }

  function hwndId(hwnd) {
    try { return String(koffi.address(hwnd)); } catch (e) { return '0'; }
  }

  return {
    isSupported: true,
    VK,

    getForegroundWindowId() {
      return hwndId(GetForegroundWindow());
    },

    // 'he' | 'en' | 'other' for the layout active in the focused window.
    getForegroundLayout() {
      const hwnd = GetForegroundWindow();
      const tid = GetWindowThreadProcessId(hwnd, null);
      const hkl = GetKeyboardLayout(tid);
      const langId = Number(BigInt(koffi.address(hkl)) & 0xFFFFn);
      if (langId === 0x040D) return 'he';
      if ((langId & 0xFF) === 0x09) return 'en'; // any English variant
      return 'other';
    },

    // Ask the focused window to switch its input language. Returns true if the
    // request was posted (the switch itself is asynchronous).
    setForegroundLayout(lang) {
      const klid = LAYOUT_KLID[lang];
      if (!klid) return false;
      const hkl = LoadKeyboardLayoutW(klid, KLF_ACTIVATE);
      const hwnd = GetForegroundWindow();
      return !!PostMessageW(hwnd, WM_INPUTLANGCHANGEREQUEST, 0, hkl);
    },

    isCapsLockOn() {
      return (GetKeyState(VK.CAPITAL) & 1) === 1;
    },

    toggleCapsLock() {
      send([
        keyInput(VK.CAPITAL, 0, 0),
        keyInput(VK.CAPITAL, 0, KEYEVENTF.KEYUP)
      ]);
    },

    // Types text into the focused app using KEYEVENTF_UNICODE, which is
    // independent of the active keyboard layout — the corrected text comes out
    // right no matter which layout the fix routine just switched to.
    sendUnicodeText(text) {
      const inputs = [];
      for (const ch of text) {
        if (ch === '\n') {
          inputs.push(keyInput(VK.RETURN, 0, 0), keyInput(VK.RETURN, 0, KEYEVENTF.KEYUP));
          continue;
        }
        const code = ch.charCodeAt(0);
        inputs.push(keyInput(0, code, KEYEVENTF.UNICODE));
        inputs.push(keyInput(0, code, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
        if (ch.length > 1) { // surrogate pair second unit
          const lo = ch.charCodeAt(1);
          inputs.push(keyInput(0, lo, KEYEVENTF.UNICODE));
          inputs.push(keyInput(0, lo, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
        }
      }
      send(inputs);
    },

    sendBackspaces(n) {
      const inputs = [];
      for (let i = 0; i < n; i++) {
        inputs.push(keyInput(VK.BACK, 0, 0), keyInput(VK.BACK, 0, KEYEVENTF.KEYUP));
      }
      send(inputs);
    },

    // Ctrl+<letter>, releasing Shift/Alt first so a physically-held hotkey
    // combo (Alt+Shift+J) doesn't contaminate the synthesized shortcut.
    sendCtrlCombo(letterVk) {
      send([
        keyInput(VK.MENU, 0, KEYEVENTF.KEYUP),
        keyInput(VK.SHIFT, 0, KEYEVENTF.KEYUP),
        keyInput(VK.CONTROL, 0, 0),
        keyInput(letterVk, 0, 0),
        keyInput(letterVk, 0, KEYEVENTF.KEYUP),
        keyInput(VK.CONTROL, 0, KEYEVENTF.KEYUP)
      ]);
    }
  };
}

let impl;
if (IS_WIN) {
  try { impl = makeWin(); }
  catch (e) {
    console.error('[KeySwitch] Failed to init Win32 layer:', e);
    impl = makeStub();
  }
} else {
  impl = makeStub();
}

module.exports = impl;
