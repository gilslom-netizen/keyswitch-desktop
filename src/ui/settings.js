// settings.js - KeySwitch Desktop settings window
// Mirrors the extension's popup.js behavior, backed by IPC instead of
// chrome.storage.
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const ks = window.keyswitch;

  const pasteArea = document.getElementById('pasteArea');
  const resultEl = document.getElementById('resultBox');
  const copyBtn = document.getElementById('copyBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsView = document.getElementById('settingsView');
  const mainView = document.getElementById('mainView');
  const autocorrectToggle = document.getElementById('autocorrectToggle');
  const autoNotifySelect = document.getElementById('autoNotifySelect');
  const showManualToastToggle = document.getElementById('showManualToastToggle');
  const primaryLangSelect = document.getElementById('primaryLangSelect');
  const launchAtLoginToggle = document.getElementById('launchAtLoginToggle');
  const shortcutCapture = document.getElementById('shortcutCapture');
  const shortcutHint = document.getElementById('shortcutHint');
  const backBtn = document.getElementById('backBtn');
  const donateLink = document.getElementById('donateLink');

  async function doConvert(text) {
    if (!text) { resultEl.textContent = ''; return; }
    const converted = await ks.convertText(text);
    resultEl.textContent = converted;
    resultEl.dir = /[\u05D0-\u05EA]/.test(converted) ? 'rtl' : 'ltr';
  }

  // Auto-convert on paste
  if (pasteArea) {
    pasteArea.addEventListener('paste', (e) => {
      // Let the paste happen, then convert
      setTimeout(async () => {
        await doConvert(pasteArea.value);
      }, 0);
    });
    // Also convert on Enter key press
    pasteArea.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        await doConvert(pasteArea.value);
      }
    });
    // Clear result when textarea is cleared
    pasteArea.addEventListener('input', async () => {
      if (!pasteArea.value) resultEl.textContent = '';
    });
  }

  copyBtn.addEventListener('click', async () => {
    const text = resultEl.textContent;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const oldIcon = copyBtn.textContent; copyBtn.textContent = '✅';
      setTimeout(() => { copyBtn.textContent = oldIcon; }, 1500);
    } catch (err) {}
  });

  function showSettings(show) {
    settingsView.style.display = show ? 'block' : 'none';
    mainView.style.display = show ? 'none' : 'block';
  }
  settingsBtn.addEventListener('click', () => showSettings(settingsView.style.display === 'none'));
  backBtn.addEventListener('click', () => showSettings(false));

  donateLink.addEventListener('click', (e) => {
    // Open in the system browser, not inside the app window.
    e.preventDefault();
    ks.openExternal(donateLink.href);
  });

  // --- Load settings -------------------------------------------------------
  // Map the two underlying booleans (showAutoToast / autoSound) to the single
  // 3-way "auto notification" dropdown and back.
  const notifyModeFromSettings = (st) =>
    (st.showAutoToast !== false) ? 'toast' : (st.autoSound ? 'sound' : 'silent');

  const s = await ks.getSettings();
  autocorrectToggle.checked = s.autocorrectEnabled !== false;
  autoNotifySelect.value = notifyModeFromSettings(s);
  showManualToastToggle.checked = s.showManualToast !== false;
  primaryLangSelect.value = s.primaryLang || 'he';
  launchAtLoginToggle.checked = s.launchAtLogin !== false;
  shortcutCapture.textContent = s.manualShortcut || 'Alt+Shift+J';
  shortcutHint.textContent = s.manualShortcut || 'Alt+Shift+J';
  document.getElementById('versionLabel').textContent = 'גרסה ' + (s.appVersion || '');
  if (!s.platformSupported) document.getElementById('unsupportedBox').style.display = 'block';

  autocorrectToggle.addEventListener('change', () => ks.setSetting('autocorrectEnabled', autocorrectToggle.checked));
  autoNotifySelect.addEventListener('change', () => {
    const mode = autoNotifySelect.value;
    ks.setSetting('showAutoToast', mode === 'toast');
    ks.setSetting('autoSound', mode === 'sound');
  });
  showManualToastToggle.addEventListener('change', () => ks.setSetting('showManualToast', showManualToastToggle.checked));
  primaryLangSelect.addEventListener('change', () => ks.setSetting('primaryLang', primaryLangSelect.value));
  launchAtLoginToggle.addEventListener('change', () => ks.setSetting('launchAtLogin', launchAtLoginToggle.checked));

  // --- Shortcut recorder ----------------------------------------------------
  let recording = false;
  shortcutCapture.addEventListener('click', () => {
    recording = true;
    shortcutCapture.classList.add('recording');
    shortcutCapture.textContent = 'הקישו צירוף...';
    shortcutCapture.focus();
  });
  shortcutCapture.addEventListener('blur', () => {
    if (!recording) return;
    recording = false;
    shortcutCapture.classList.remove('recording');
    ks.getSettings().then((cur) => { shortcutCapture.textContent = cur.manualShortcut || 'Alt+Shift+J'; });
  });
  shortcutCapture.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (key === ' ') key = 'Space';
    parts.push(key);
    if (parts.length < 2) return; // require at least one modifier
    const accel = parts.join('+');
    recording = false;
    shortcutCapture.classList.remove('recording');
    shortcutCapture.textContent = accel;
    shortcutHint.textContent = accel;
    ks.setSetting('manualShortcut', accel);
  });

  // --- Stats ----------------------------------------------------------------
  const statsBox = document.getElementById('statsBox');
  function renderStats(stats) {
    if (stats.total > 0) {
      document.getElementById('totalSaved').textContent = stats.total.toLocaleString();
      document.getElementById('autoStats').textContent = stats.auto.toLocaleString();
      document.getElementById('manualStats').textContent = stats.manual.toLocaleString();
      statsBox.style.display = 'block';
    } else {
      statsBox.style.display = 'none';
    }
  }
  renderStats(await ks.getStats());
  ks.onStatsChanged(renderStats);

  ks.onSettingsChanged(({ key, value }) => {
    if (key === 'autocorrectEnabled') autocorrectToggle.checked = value !== false;
    // showAutoToast / autoSound both feed the single auto-notification dropdown;
    // re-read the full settings to resolve the resulting mode when either changes.
    if (key === 'showAutoToast' || key === 'autoSound') {
      ks.getSettings().then((cur) => { autoNotifySelect.value = notifyModeFromSettings(cur); });
    }
    if (key === 'showManualToast') showManualToastToggle.checked = value !== false;
    if (key === 'primaryLang') primaryLangSelect.value = value || 'he';
    if (key === 'launchAtLogin') launchAtLoginToggle.checked = value !== false;
    if (key === 'manualShortcut') { shortcutCapture.textContent = value; shortcutHint.textContent = value; }
  });

  if (pasteArea) pasteArea.focus();
});
