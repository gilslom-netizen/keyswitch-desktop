// main.js - KeySwitch Desktop
// =============================================================================
// Electron entry point: tray app + settings window (same design as the
// extension popup) + toast overlay + global manual-conversion shortcut +
// the system-wide autocorrect engine.
// =============================================================================
'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, clipboard, screen, shell, session, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

// Allow the (possibly hidden) toast window to play the notification sound in
// "sound only" mode without a user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The notification sound — shared by auto-correction and the manual shortcut,
// so both give the exact same audible confirmation. Preferred path: notify.wav
// played natively via winmm from the main process (lowest latency — no IPC
// hop, no MP3 decode). Fallback path: notify.mp3 handed to the toast renderer
// as a data: URI (avoids file:// CSP 'self' matching quirks).
let notifySoundDataUri = null;
let notifyWavBuffer = null;
function loadNotifySound() {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'notify.mp3'));
    notifySoundDataUri = 'data:audio/mpeg;base64,' + buf.toString('base64');
  } catch (e) {
    notifySoundDataUri = null;
  }
  try {
    notifyWavBuffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'notify.wav'));
  } catch (e) {
    notifyWavBuffer = null;
  }
}

// Warm up winmm's playback path once at startup with a few milliseconds of
// silence, so the FIRST real notification doesn't pay the one-time cost of
// initializing the audio session.
function prewarmNotifySound() {
  if (!notifyWavBuffer || !native.playWav) return;
  const rate = 24000, samples = 96; // 4ms of silence
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  try { native.playWav(wav); } catch (e) {}
}

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
let welcomeWin = null;
let toastWin = null;
let toastHideTimer = null;
let currentToastType = null; // 'auto' | 'manual' | 'info' | null — which toast is showing
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
  loadNotifySound();
  prewarmNotifySound();

  settings = new SettingsStore(app.getPath('userData'));

  engine = new AutocorrectEngine({ native, settings });
  engine.on('corrected', onAutoCorrected);
  // The auto-toast lives for as long as the correction's "session" does: when
  // the engine stops tracking the last fix (user left the field / clicked /
  // started a new burst) or the fix was reverted, dismiss the toast — matching
  // the extension's "disappears when you leave the field" behavior. Only the
  // auto-toast follows the session; a manual/info toast keeps its own timer.
  const dismissAutoToast = () => { if (currentToastType === 'auto') hideToast(); };
  engine.on('fix-tracking-ended', dismissAutoToast);
  engine.on('reverted', dismissAutoToast);
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

  // If this launch is the relaunch right after a background auto-update, the
  // installer ran us with no --hidden flag; consume the marker and stay hidden
  // in the tray so a silent update doesn't pop a window in the user's face.
  let relaunchedFromUpdate = false;
  try {
    const marker = updateMarkerPath();
    if (fs.existsSync(marker)) {
      // Only treat it as a post-update relaunch if the marker is fresh; a stale
      // one (left by a crash between writing it and installing) must not suppress
      // the window forever. Either way, consume it.
      const ts = Number(fs.readFileSync(marker, 'utf8')) || 0;
      if (Date.now() - ts < 5 * 60 * 1000) relaunchedFromUpdate = true;
      fs.unlinkSync(marker);
    }
  } catch (e) {}

  // First run after install (the installer launches us via runAfterFinish):
  // show the styled welcome/onboarding screen once instead of the settings
  // window. On every later launch, behave normally.
  if (!START_HIDDEN && !relaunchedFromUpdate) {
    if (settings.get('welcomeShown') !== true) showWelcomeWindow();
    else showSettingsWindow();
  }
  if (native.isSupported && !hookOk) {
    showToast({ type: 'info', text: 'שגיאה בהפעלת מנוע התיקון האוטומטי — נסו להפעיל מחדש' });
  }
}

function showWelcomeWindow() {
  if (welcomeWin && !welcomeWin.isDestroyed()) { welcomeWin.show(); welcomeWin.focus(); return; }
  welcomeWin = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'ברוכים הבאים ל-KeySwitch',
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
  welcomeWin.removeMenu();
  welcomeWin.loadFile(path.join(__dirname, 'ui', 'welcome.html'));
  // Mark shown on ANY close (button or the window's X) so it's truly one-time.
  welcomeWin.on('closed', () => {
    welcomeWin = null;
    if (settings) settings.set('welcomeShown', true);
  });
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

// All toasts are pinned to the BOTTOM-LEFT corner of the primary display's
// work area, matching the browser extension's auto-toast placement.
const TOAST_MARGIN = 20;
function positionToast() {
  if (!toastWin) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = toastWin.getSize();
  toastWin.setPosition(
    Math.round(workArea.x + TOAST_MARGIN),
    Math.round(workArea.y + workArea.height - h - TOAST_MARGIN)
  );
  updateToastProtectedRect();
}

// Keep the engine's mouse-click protection rectangle aligned with the toast's
// on-screen bounds while it is visible (so clicking the revert button doesn't
// tear down the pending fix — see engine._onMousedown).
function updateToastProtectedRect() {
  if (!engine) return;
  if (toastWin && !toastWin.isDestroyed() && toastWin.isVisible()) {
    // The global mouse hook reports PHYSICAL screen pixels, while getBounds()
    // is in DIP. On a scaled display (e.g. 150%) they differ, so convert the
    // window bounds to physical coords before handing them to the engine —
    // otherwise clicking the revert button on a scaled monitor wouldn't be
    // recognized as "inside the toast" and would cancel the pending fix.
    const dip = toastWin.getBounds();
    try {
      engine.protectedRect = screen.dipToScreenRect(toastWin, dip);
    } catch (e) {
      engine.protectedRect = dip;
    }
  } else {
    engine.protectedRect = null;
  }
}

// Deliver a message to the toast renderer, waiting for the page if it is
// still loading. At app startup (or right after the window was recreated) a
// correction can fire before toast.html wired its IPC listeners — a message
// sent straight away would vanish and the toast would pop up EMPTY.
function sendToToast(channel, payload) {
  if (!toastWin || toastWin.isDestroyed()) return;
  const wc = toastWin.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => {
      try { wc.send(channel, payload); } catch (e) {}
    });
  } else {
    wc.send(channel, payload);
  }
}

function showToast(payload) {
  if (!toastWin || toastWin.isDestroyed()) createToastWindow();
  currentToastType = payload.type || 'info';
  positionToast();
  sendToToast('toast:show', payload);
  toastWin.showInactive();
  updateToastProtectedRect();
  clearTimeout(toastHideTimer);
  // The auto-correction toast mirrors the extension: it is NOT dismissed on a
  // short fixed timer — it lingers (semi-transparent) until the correction's
  // "session" ends, i.e. the user leaves the field / clicks / starts a new
  // burst (engine emits 'fix-tracking-ended' / 'reverted', wired in init()).
  // A generous safety cap only guards against a missed end-event so it can
  // never get stuck on screen forever. Manual/info toasts keep a short timer.
  const ttl = payload.type === 'auto' ? 15000 : (payload.type === 'manual' ? 2500 : 3500);
  toastHideTimer = setTimeout(hideToast, ttl);
}

function hideToast() {
  clearTimeout(toastHideTimer);
  currentToastType = null;
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
  updateToastProtectedRect();
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
// Releases for a newer version and downloads it in the background. Installing
// it is the part that has to be handled carefully for a TRAY app: relying on
// `autoInstallOnAppQuit` alone means the update only lands when the process
// fully exits — but a tray app launched at login almost never exits (closing
// the window just hides it), so the downloaded update would sit unused for
// days and the user sees "a new version was found" but never actually gets it.
//
// So once an update is downloaded we install it automatically the moment the
// machine is IDLE (the user stepped away), silently, and relaunch hidden so
// the whole thing is seamless — the user simply comes back to the new version
// already running in the tray. `autoInstallOnAppQuit` stays on as a fallback
// for the shutdown/restart/exit paths.
//
// Requires the build to publish `latest.yml` next to the installer in each
// GitHub Release (the CI workflow uploads it), and the `publish` block in
// package.json. In an unpacked/dev run (`app.isPackaged === false`) the updater
// is skipped, because there is no app-update.yml to read.
let autoUpdater = null;
let manualUpdateCheck = false;
let idleInstallTimer = null;
let installingUpdate = false;

// How long the machine must be idle before we auto-install a ready update, and
// how often we check. Conservative so we never yank the app out from under
// someone who's just reading — only when they've clearly stepped away.
const IDLE_INSTALL_SECS = 120;
const IDLE_POLL_MS = 30 * 1000;
// Marker file: written just before we quit to install, so the freshly-relaunched
// instance knows to start HIDDEN (straight to the tray) instead of popping the
// settings window after a silent background update.
function updateMarkerPath() {
  return path.join(app.getPath('userData'), '.ks-updating');
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      console.log('[KeySwitch] update available:', info && info.version);
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
      showToast({ type: 'info', text: `גרסה ${info.version} תותקן אוטומטית — או עכשיו מהתפריט` });
      console.log('[KeySwitch] update downloaded:', info && info.version);
      startIdleInstallWatch();
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

// Once an update is ready, watch for the user to step away and install it then.
function startIdleInstallWatch() {
  if (idleInstallTimer) return;
  idleInstallTimer = setInterval(() => {
    if (!updateReady || installingUpdate) return;
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { return; }
    // Don't interrupt an in-flight manual conversion even if input is briefly idle.
    if (idle >= IDLE_INSTALL_SECS && !manualBusy) {
      performUpdateInstall(true);
    }
  }, IDLE_POLL_MS);
}

// Quit and install the downloaded update. `silent` (idle auto-install) runs the
// NSIS installer with no UI and relaunches hidden; the manual tray action uses
// silent=false so the user sees the familiar installer progress.
function performUpdateInstall(silent) {
  if (!autoUpdater || !updateReady || installingUpdate) return;
  installingUpdate = true;
  if (idleInstallTimer) { clearInterval(idleInstallTimer); idleInstallTimer = null; }
  app.isQuitting = true;
  try {
    // Leave a marker so the relaunched instance starts straight into the tray
    // (hidden) rather than opening a window after a background update.
    fs.writeFileSync(updateMarkerPath(), String(Date.now()));
  } catch (e) {}
  try {
    autoUpdater.quitAndInstall(silent, true); // isSilent, isForceRunAfter
  } catch (e) {
    console.error('[KeySwitch] quitAndInstall failed:', e);
    installingUpdate = false;
    app.isQuitting = false;
    try { fs.unlinkSync(updateMarkerPath()); } catch (e2) {}
    if (silent) startIdleInstallWatch(); // idle path: try again later
    else showToast({ type: 'info', text: 'ההתקנה נכשלה — נסו שוב מאוחר יותר' });
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
  // Manual "install now" from the tray: show the installer UI (silent=false).
  performUpdateInstall(false);
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
    // Save whatever the user has on the clipboard so the shortcut is
    // side-effect-free. Text is not enough: if they had an IMAGE copied
    // (e.g. a screenshot), readText() is '' and restoring '' at the end
    // would destroy the image — keep the image too and put back whichever
    // was there.
    const savedText = clipboard.readText();
    const savedImage = savedText ? null : clipboard.readImage();
    const restoreClipboard = () => {
      if (savedImage && !savedImage.isEmpty()) clipboard.writeImage(savedImage);
      else clipboard.writeText(savedText);
    };
    const SENTINEL = '__KS_EMPTY_' + Date.now() + '__';
    clipboard.writeText(SENTINEL);

    native.sendCtrlCombo(native.VK.C);
    // Poll instead of one fixed sleep: fast apps deliver the copy within
    // ~50ms (the shortcut feels instant), while slow ones (Word with a big
    // selection) get up to 600ms before we conclude nothing was selected —
    // the old fixed 180ms was both slower for the common case and too short
    // for the slow one (it showed "select text" even when text WAS selected).
    let selected = '';
    for (let waited = 0; waited < 600; waited += 50) {
      await sleep(50);
      selected = clipboard.readText();
      if (selected && selected !== SENTINEL) break;
    }
    if (!selected || selected === SENTINEL) {
      restoreClipboard();
      showToast({ type: 'info', text: 'סמנו טקסט ולחצו שוב על הקיצור' });
      return;
    }

    const converted = convertFullText(selected);
    if (converted === selected) {
      restoreClipboard();
      return;
    }

    clipboard.writeText(converted);
    native.sendCtrlCombo(native.VK.V);
    // Audible confirmation that the shortcut did something — on by default, so
    // the user gets instant feedback even with the manual toast off (its
    // default). Played right after the paste is sent so it feels immediate,
    // and distinct from the auto-correction sound. Can be turned off in
    // settings (manualSound).
    if (settings.get('manualSound') !== false) playNotifySound();
    // Give the target app time to actually process the paste before the
    // clipboard is restored — restoring too early makes a slow app paste
    // the user's OLD clipboard content instead of the converted text.
    await sleep(400);
    restoreClipboard();

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

  // Feedback mode (item 7): toast (default) → sound-only → fully silent.
  //   showAutoToast !== false            → show the toast
  //   else if autoSound                  → just a short beep, no toast
  //   else                               → nothing at all
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
  } else if (settings.get('autoSound')) {
    playNotifySound();
  }
}

// Play the notification sound — the SAME sound for auto-correction and the
// manual shortcut, so both feel like the same product confirming the same
// kind of action. Fastest path first: the WAV played natively from this
// process (starts within milliseconds). Fallbacks: the toast renderer's Audio
// pipeline, then the system beep.
function playNotifySound() {
  try {
    if (notifyWavBuffer && native.playWav && native.playWav(notifyWavBuffer)) return;
    if (notifySoundDataUri && toastWin && !toastWin.isDestroyed()) {
      sendToToast('sound:play', notifySoundDataUri);
    } else {
      native.beep();
    }
  } catch (e) {
    try { native.beep(); } catch (e2) {}
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
  const ALLOWED = ['autocorrectEnabled', 'showAutoToast', 'autoSound', 'showManualToast', 'manualSound', 'primaryLang', 'manualShortcut', 'launchAtLogin'];
  if (ALLOWED.includes(key)) settings.set(key, value);
});
ipcMain.handle('convert:text', (e, text) => convertFullText(text || ''));
ipcMain.handle('stats:get', () => getStats());
ipcMain.on('toast:action', (e, action) => {
  if (action === 'revert') {
    // revertLastFix reaches Win32 (SendInput/koffi) — unlike the keyboard-hook
    // path there is no outer catch here, and a native failure must not become
    // an uncaught exception in the main process.
    try { engine.revertLastFix(); } catch (err) {
      console.error('[KeySwitch] revert failed:', err);
    }
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
ipcMain.on('welcome:done', () => {
  settings.set('welcomeShown', true);
  if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
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
