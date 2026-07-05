// main.js - KeySwitch Desktop
// =============================================================================
// Electron entry point: tray app + settings window (same design as the
// extension popup) + toast overlay + global manual-conversion shortcut +
// the system-wide autocorrect engine.
// =============================================================================
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, shell } = require('electron');
const path = require('path');

const native = require('./native/win');
const { SettingsStore } = require('./settings-store');
const { convertFullText } = require('./engine/shared_logic');
const { AutocorrectEngine } = require('./engine/autocorrect-engine');

const START_HIDDEN = process.argv.includes('--hidden');

let settings;
let engine;
let tray = null;
let settingsWin = null;
let toastWin = null;
let toastHideTimer = null;
let currentShortcut = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showSettingsWindow());
  app.whenReady().then(init);
}

function init() {
  settings = new SettingsStore(app.getPath('userData'));

  engine = new AutocorrectEngine({ native, settings });
  engine.on('corrected', onAutoCorrected);
  const hookOk = engine.start();

  createTray();
  createToastWindow();
  registerShortcut(settings.get('manualShortcut'));
  applyLoginItem();

  settings.on('change', (key, value) => {
    if (key === 'manualShortcut') registerShortcut(value);
    if (key === 'launchAtLogin') applyLoginItem();
    if (key === 'autocorrectEnabled') refreshTrayMenu();
    broadcast('settings:changed', { key, value });
  });

  if (!START_HIDDEN) showSettingsWindow();
  if (native.isSupported && !hookOk) {
    showToast({ type: 'info', text: 'שגיאה בהפעלת מנוע התיקון האוטומטי — נסו להפעיל מחדש' });
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function showSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'KeySwitch',
    icon: path.join(__dirname, '..', 'assets', 'icon128.png'),
    backgroundColor: '#1a1a2e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function createToastWindow() {
  toastWin = new BrowserWindow({
    width: 340,
    height: 220,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.loadFile(path.join(__dirname, 'ui', 'toast.html'));
  toastWin.on('closed', () => { toastWin = null; });
}

function positionToast() {
  if (!toastWin) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = toastWin.getSize();
  toastWin.setPosition(
    Math.round(workArea.x + (workArea.width - w) / 2),
    Math.round(workArea.y + workArea.height - h - 24)
  );
}

function showToast(payload) {
  if (!toastWin || toastWin.isDestroyed()) createToastWindow();
  positionToast();
  toastWin.webContents.send('toast:show', payload);
  toastWin.showInactive();
  clearTimeout(toastHideTimer);
  const ttl = payload.type === 'auto' ? 8000 : (payload.type === 'manual' ? 5000 : 3500);
  toastHideTimer = setTimeout(hideToast, ttl);
}

function hideToast() {
  clearTimeout(toastHideTimer);
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon32.png'));
  tray.setToolTip('KeySwitch — תיקון שפת מקלדת');
  tray.on('double-click', showSettingsWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'פתח את KeySwitch', click: showSettingsWindow },
    { type: 'separator' },
    {
      label: 'תיקון אוטומטי בזמן הקלדה',
      type: 'checkbox',
      checked: settings.get('autocorrectEnabled') !== false,
      click: (item) => settings.set('autocorrectEnabled', item.checked)
    },
    { type: 'separator' },
    { label: 'תרומה למפתחים ❤️', click: () => shell.openExternal('https://www.paypal.com/ncp/payment/TCZCRSCYJRR9G') },
    { label: 'יציאה', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Global manual-conversion shortcut (Alt+Shift+J by default): copies the
// selection, converts it with the exact extension logic, pastes the result
// back, and aligns the keyboard layout with the converted language. Works in
// any application, including ones the extension could never touch.
// ---------------------------------------------------------------------------
function registerShortcut(accel) {
  if (currentShortcut) {
    try { globalShortcut.unregister(currentShortcut); } catch (e) {}
    currentShortcut = null;
  }
  if (!accel) return;
  try {
    const ok = globalShortcut.register(accel, manualConvert);
    if (ok) currentShortcut = accel;
    else showToast({ type: 'info', text: `לא ניתן לרשום את הקיצור ${accel} — ייתכן שהוא תפוס` });
  } catch (e) {
    showToast({ type: 'info', text: 'קיצור מקלדת לא תקין' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let manualBusy = false;
async function manualConvert() {
  if (manualBusy || !native.isSupported) return;
  manualBusy = true;
  try {
    const savedText = clipboard.readText();
    const SENTINEL = '__KS_EMPTY_' + Date.now() + '__';
    clipboard.writeText(SENTINEL);

    native.sendCtrlCombo(native.VK.C);
    await sleep(180);

    const selected = clipboard.readText();
    if (!selected || selected === SENTINEL) {
      clipboard.writeText(savedText);
      showToast({ type: 'info', text: 'סמנו טקסט ולחצו שוב על הקיצור' });
      return;
    }

    const converted = convertFullText(selected);
    if (converted === selected) {
      clipboard.writeText(savedText);
      return;
    }

    clipboard.writeText(converted);
    native.sendCtrlCombo(native.VK.V);
    await sleep(250);
    clipboard.writeText(savedText);

    // Align the keyboard layout with the language the user clearly wants now.
    const targetLang = /[֐-׿]/.test(converted) ? 'he' : 'en';
    if (native.getForegroundLayout() !== targetLang) native.setForegroundLayout(targetLang);

    const words = converted.trim() ? converted.trim().split(/\s+/).length : 0;
    settings.increment('totalCorrectedWords', words);
    settings.increment('totalManualCorrectedWords', words);
    broadcast('stats:changed', getStats());

    if (settings.get('showManualToast') !== false) {
      showToast({ type: 'manual', original: selected, converted });
    }
  } catch (e) {
    console.error('[KeySwitch] manual convert failed:', e);
  } finally {
    manualBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Autocorrect events
// ---------------------------------------------------------------------------
function onAutoCorrected(info) {
  settings.increment('totalCorrectedWords', info.wordCount);
  settings.increment('totalAutoCorrectedWords', info.wordCount);
  broadcast('stats:changed', getStats());
  if (settings.get('showAutoToast') !== false) {
    // Deliberately NOT sending info.original/info.converted here: unlike the
    // manual-shortcut toast (an explicit, user-initiated action on text the
    // user chose to select), this toast fires passively during normal typing
    // with zero user intent — including inside password/passphrase fields,
    // since the global keyboard hook has no concept of input field type. The
    // fixed text could be a secret, so it must never leave the engine, not
    // even over the internal IPC channel to the toast window's renderer.
    showToast({
      type: 'auto',
      capsFixed: info.capsFixed,
      layoutSwitched: info.layoutSwitched,
      targetLang: info.targetLang
    });
  }
}

// ---------------------------------------------------------------------------
// Login item / IPC plumbing
// ---------------------------------------------------------------------------
function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: settings.get('launchAtLogin') !== false,
    args: ['--hidden']
  });
}

function getStats() {
  return {
    total: settings.get('totalCorrectedWords') || 0,
    auto: settings.get('totalAutoCorrectedWords') || 0,
    manual: settings.get('totalManualCorrectedWords') || 0
  };
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

ipcMain.handle('settings:get-all', () => ({
  ...settings.all(),
  appVersion: app.getVersion(),
  platformSupported: native.isSupported
}));
ipcMain.on('settings:set', (e, key, value) => {
  const ALLOWED = ['autocorrectEnabled', 'showAutoToast', 'showManualToast', 'primaryLang', 'manualShortcut', 'launchAtLogin'];
  if (ALLOWED.includes(key)) settings.set(key, value);
});
ipcMain.handle('convert:text', (e, text) => convertFullText(text || ''));
ipcMain.handle('stats:get', () => getStats());
ipcMain.on('toast:action', (e, action) => {
  if (action === 'revert') {
    engine.revertLastFix();
    hideToast();
  } else if (action === 'disable-auto') {
    settings.set('autocorrectEnabled', false);
    hideToast();
  } else if (action === 'hide-auto-toast') {
    settings.set('showAutoToast', false);
    hideToast();
  } else if (action === 'close') {
    hideToast();
  }
});
ipcMain.on('open-external', (e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('toast:resize', (e, height) => {
  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.setSize(340, Math.max(60, Math.min(320, Math.round(height))));
    positionToast();
  }
});

app.on('window-all-closed', (e) => {
  // Tray app: keep running in the background.
});

app.on('before-quit', () => {
  try { engine && engine.stop(); } catch (e) {}
  try { globalShortcut.unregisterAll(); } catch (e) {}
  try { settings && settings.save(); } catch (e) {}
});
