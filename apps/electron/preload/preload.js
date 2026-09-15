const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onRuntimePort: (callback) => {
    const handler = (_event, port) => callback(port)
    ipcRenderer.on('runtime-port', handler)
    return () => ipcRenderer.removeListener('runtime-port', handler)
  },
  onShortcut: (callback) => {
    const handler = (_event, type) => callback(type)
    ipcRenderer.on('shortcut', handler)
    return () => ipcRenderer.removeListener('shortcut', handler)
  },
  openSettingsWindow: () => ipcRenderer.send('open-settings-window'),
  getRuntimePort: () => ipcRenderer.invoke('get-runtime-port'),
})
