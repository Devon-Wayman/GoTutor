const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("goAR", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: patch => ipcRenderer.invoke("settings:set", patch),

  listDisplays: () => ipcRenderer.invoke("displays:list"),
  openProjector: displayId => ipcRenderer.invoke("projector:open", displayId),
  closeProjector: () => ipcRenderer.invoke("projector:close"),
  identifyDisplays: () => ipcRenderer.invoke("projector:identify"),

  autoCalibrate: displayId => ipcRenderer.invoke("calibration:auto", displayId),

  onDisplaysChanged: callback =>
    ipcRenderer.on("displays:changed", (_event, displays) => callback(displays)),

  onProjectorDetected: callback =>
    ipcRenderer.on("projector:detected", (_event, display) => callback(display)),

  onCalibrationProgress: callback =>
    ipcRenderer.on("calibration:progress", (_event, data) => callback(data)),

  onCalibrationComplete: callback =>
    ipcRenderer.on("calibration:complete", (_event, data) => callback(data)),

  onProjectorPattern: callback =>
    ipcRenderer.on("projector:pattern", (_event, data) => callback(data))
});
