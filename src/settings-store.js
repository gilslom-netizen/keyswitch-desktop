// settings-store.js - KeySwitch Desktop
// =============================================================================
// JSON settings persisted to %APPDATA%\KeySwitch\settings.json.
// The keys intentionally match the browser extension's chrome.storage.local
// keys (autocorrectEnabled, showAutoToast, showManualToast, primaryLang,
// totalCorrectedWords, ...) so behavior and docs stay in sync between the two
// projects. The NSIS installer pre-seeds this same file with the choices the
// user made on the installer's settings page (or with settings embedded in
// the download link's KSCFG token).
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  autocorrectEnabled: true,
  showAutoToast: true,
  showManualToast: true,
  primaryLang: 'he',
  manualShortcut: 'Alt+Shift+J',
  launchAtLogin: true,
  totalCorrectedWords: 0,
  totalAutoCorrectedWords: 0,
  totalManualCorrectedWords: 0,
  acWordState: {}
};

class SettingsStore extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULTS, ...parsed };
    } catch (e) {
      this.data = { ...DEFAULTS };
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  set(key, value) {
    if (this.data[key] === value && typeof value !== 'object') return;
    this.data[key] = value;
    this._scheduleSave();
    this.emit('change', key, value);
  }

  increment(key, by = 1) {
    this.set(key, (Number(this.data[key]) || 0) + by);
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 250);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[KeySwitch] failed to save settings:', e);
    }
  }
}

module.exports = { SettingsStore, DEFAULTS };
