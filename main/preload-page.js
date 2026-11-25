'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('withlook', {
  submitSelection: (data) => ipcRenderer.send('picker:result', data),
  cancelSelection: () => ipcRenderer.send('picker:cancel'),
  uiAction: (a) => ipcRenderer.send('page:ui', a),
  welcome: () => ipcRenderer.invoke('welcome:data'),
  removeProject: (folder) => ipcRenderer.invoke('projects:remove', folder),
  pickCreateLocation: () => ipcRenderer.invoke('create:pickLocation'),
  submitCreate: (opts) => ipcRenderer.invoke('create:submit', opts),
  cancelCreate: () => ipcRenderer.invoke('create:cancel'),
  onCreateStatus: (cb) => ipcRenderer.on('create:status', (_e, s) => cb(s)),
  onCreateLog: (cb) => ipcRenderer.on('create:log', (_e, l) => cb(l)),
});
