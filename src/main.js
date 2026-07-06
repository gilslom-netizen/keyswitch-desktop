// main.js - KeySwitch Desktop
// =============================================================================
// Electron entry point: tray app + settings window (same design as the
// extension popup) + toast overlay + global manual-conversion shortcut +
// the system-wide autocorrect engine.
// =============================================================================
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, shell, session } = require('electron');
const path = require('path');

const native = require('./native/win');
const { SettingsStore } = require('./settings-store');
const { convertFullText } = require('./engine/shared_logic');
const { AutocorrectEngine } = require('./engine/autocorrect-engine');
const { startHealthServer } = require('./health-server');

const START_HIDDEN = process.argv.includes('--hidden');

let settings;
let engine;
let tray = null;
let settingsWin = null;
let toastWin = null;
let toastHideTimer = null;
let currentShortcut = null;
let healthServer = null;
let updateReady = false; // an update has been downloaded and will install on quit

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showSettingsWindow());
  app.whenReady().then(init);
}

function init() {
  applySecurityHardening();

  settings = new SettingsStore(app.getPath('userData'));

  engine = new AutocorrectEngine({ native, settings });
  engine.on('corrected', onAutoCorrected);
  const hookOk = engine.start();

  createTray();
  createToastWindow();
  registerShortcut(settings.get('manualShortcut'));
  applyLoginItem();

  // Loopback liveness endpoint so the Chrome extension can detect us and stand
  // down (prevents double auto-correction). See health-server.js.
  healthServer = startHealthServer(() => ({ version: app.getVersion() }));

  setupAutoUpdate();

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
// SECURITY HARDENING — defense-in-depth beyond contextIsolation/nodeIntegration.
// None of this changes normal behavior: every window here only ever loads our
// own local file:// HTML and never navigates anywhere, requests a permission,
// or needs a new window — so these handlers only ever fire on something that
// was never supposed to happen in the first place (a bug, or a compromised
// renderer trying to escalate). Applied once, globally, to every webContents
// this app ever creates (current windows and any future one), per Electron's
// own security checklist, rather than repeated per-BrowserWindow.
// ---------------------------------------------------------------------------
function applySecurityHardening() {
  // Deny every permission request (camera/mic/notifications/geolocation/...) —
  // this app has no legitimate use for any of them.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(false));

  app.on('web-contents-created', (event, contents) => {
    // Block navigation away from our own local pages entirely.
    contents.on('will-navigate', (e) => e.preventDefault());
    // Block creation of any new window/tab (e.g. via window.open or a stray
    // target="_blank" link) instead of letting Chromium open it.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
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
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
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
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
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
  const items = [
    { label: 'פתח את KeySwitch', click: showSettingsWindow },
    { type: 'separator' },
    {
      label: 'תיקון אוטומטי בזמן הקלדה',
      type: 'checkbox',
      checked: settings.get('autocorrectEnabled') !== false,
      click: (item) => settings.set('autocorrectEnabled', item.checked)
    },
    { type: 'separator' }
  ];
  // Once an update has been downloaded, offer to restart into it now; otherwise
  // offer a manual check.
  if (updateReady) {
    items.push({ label: '🔄 התקן עדכון והפעל מחדש', click: () => quitAndInstallUpdate() });
  } else {
    items.push({ label: 'בדוק עדכונים', click: () => checkForUpdatesManually() });
  }
  items.push(
    { label: 'תרומה למפתחים ❤️', click: () => shell.openExternal('https://www.paypal.com/ncp/payment/TCZCRSCYJRR9G') },
    { label: 'יציאה', click: () => { app.isQuitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------------------
// AUTO-UPDATE (electron-updater against GitHub Releases)
// ---------------------------------------------------------------------------
// On every launch (and every 6 hours after) the app checks the repo's GitHub
// Releases for a newer version, downloads it in the background, and installs it
// the next time the app quits — so users are NOT stuck forever on whatever
// version they first downloaded. A tray item also lets them check on demand or
// restart-to-update immediately once one is ready.
//
// Requires the build to publish `latest.yml` next to the installer in each
// GitHub Release (the CI workflow uploads it), and the `publish` block in
// package.json. In an unpacked/dev run (`app.isPackaged === false`) the updater
// is skipped, because there is no code signature or app-update.yml to read.
let autoUpdater = null;
let manualUpdateCheck = false;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      if (manualUpdateCheck) {
        showToast({ type: 'info', text: `גרסה ${info.version} נמצאה — מורידה ברקע...` });
      }
    });
    autoUpdater.on('update-not-available', () => {
      if (manualUpdateCheck) {
        showToast({ type: 'info', text: 'אתם משתמשים בגרסה העדכנית ביותר 🎉' });
        manualUpdateCheck = false;
      }
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = true;
      manualUpdateCheck = false;
      refreshTrayMenu();
      showToast({ type: 'info', text: `גרסה ${info.version} מוכנה — תותקן ביציאה מהתוכנה` });
    });
    autoUpdater.on('error', (err) => {
      if (manualUpdateCheck) {
        showToast({ type: 'info', text: 'בדיקת העדכונים נכשלה — נסו שוב מאוחר יותר' });
        manualUpdateCheck = false;
      }
      console.error('[KeySwitch] auto-update error:', err && err.message);
    });

    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => {
      if (!updateReady) autoUpdater.checkForUpdates().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  } catch (e) {
    console.error('[KeySwitch] failed to init auto-update:', e);
  }
}

function checkForUpdatesManually() {
  if (!app.isPackaged) {
    showToast({ type: 'info', text: 'בדיקת עדכונים זמינה רק בגרסה המותקנת' });
    return;
  }
  if (!autoUpdater) { setupAutoUpdate(); }
  if (!autoUpdater) return;
  manualUpdateCheck = true;
  showToast({ type: 'info', text: 'בודק עדכונים...' });
  autoUpdater.checkForUpdates().catch(() => {});
}

function quitAndInstallUpdate() {
  if (!autoUpdater) return;
  app.isQuitting = true;
  // isSilent=false (show the installer), isForceRunAfter=true (relaunch after).
  autoUpdater.quitAndInstall(false, true);
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
  try { healthServer && healthServer.close(); } catch (e) {}
  try { settings && settings.save(); } catch (e) {}
});
