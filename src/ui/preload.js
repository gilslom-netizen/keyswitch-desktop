// preload.js - KeySwitch Desktop
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyswitch', {
  getSettings: () => ipcRenderer.invoke('settings:get-all'),
  setSetting: (key, value) => ipcRenderer.send('settings:set', key, value),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (e, data) => cb(data)),
  convertText: (text) => ipcRenderer.invoke('convert:text', text),
  getStats: () => ipcRenderer.invoke('stats:get'),
  onStatsChanged: (cb) => ipcRenderer.on('stats:changed', (e, data) => cb(data)),
  onToastShow: (cb) => ipcRenderer.on('toast:show', (e, data) => cb(data)),
  toastAction: (action) => ipcRenderer.send('toast:action', action),
  toastResize: (height) => ipcRenderer.send('toast:resize', height),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});
