const {
  contextBridge,
  ipcRenderer
} = require("electron");

contextBridge.exposeInMainWorld(
  "goAR",
  {
    getSettings: () =>
      ipcRenderer.invoke(
        "settings:get"
      ),

    debugLog: (category,event,data=null) =>
      ipcRenderer.invoke(
        "debug:log",
        {category,event,data}
      ),

    setSettings: patch =>
      ipcRenderer.invoke(
        "settings:set",
        patch
      ),

    listDisplays: () =>
      ipcRenderer.invoke(
        "displays:list"
      ),

    openProjector: displayId =>
      ipcRenderer.invoke(
        "projector:open",
        displayId
      ),

    closeProjector: () =>
      ipcRenderer.invoke(
        "projector:close"
      ),

    /*
     * NEW:
     * Set the entire projector to a grayscale illumination level.
     *
     * 0.0 = black
     * 1.0 = white
     */
    setProjectorIllumination: level =>
      ipcRenderer.invoke(
        "projector:solid",
        level
      ),

    blackProjector: () =>
      ipcRenderer.invoke(
        "projector:black"
      ),

    identifyDisplays: () =>
      ipcRenderer.invoke(
        "projector:identify"
      ),

    autoCalibrate: displayId =>
      ipcRenderer.invoke(
        "calibration:auto",
        displayId
      ),

    getKataGoPaths: () =>
      ipcRenderer.invoke(
        "katago:paths:get"
      ),

    setKataGoPaths: values =>
      ipcRenderer.invoke(
        "katago:paths:set",
        values
      ),

    detectKataGoPaths: () =>
      ipcRenderer.invoke(
        "katago:paths:detect"
      ),

    chooseKataGoFile: kind =>
      ipcRenderer.invoke(
        "katago:choose-file",
        kind
      ),

    testKataGo: config =>
      ipcRenderer.invoke(
        "katago:test",
        config
      ),

    kataGoGenMove: payload =>
      ipcRenderer.invoke(
        "katago:genmove",
        payload
      ),

    renderGame: payload =>
      ipcRenderer.invoke(
        "game:render",
        payload
      ),

    renderOrientationPreview: payload =>
      ipcRenderer.invoke(
        "game:orientation-preview",
        payload
      ),

    renderGridPreview: payload =>
      ipcRenderer.invoke(
        "projector:grid-preview",
        payload
      ),

    renderStoneZonePreview: payload =>
      ipcRenderer.invoke(
        "projector:stone-zone-preview",
        payload
      ),

    clearGameProjection: () =>
      ipcRenderer.invoke(
        "game:clear-projection"
      ),

    onDisplaysChanged: callback =>
      ipcRenderer.on(
        "displays:changed",
        (
          _event,
          displays
        ) =>
          callback(
            displays
          )
      ),

    onProjectorDetected: callback =>
      ipcRenderer.on(
        "projector:detected",
        (
          _event,
          display
        ) =>
          callback(
            display
          )
      ),

    onCalibrationProgress: callback =>
      ipcRenderer.on(
        "calibration:progress",
        (
          _event,
          data
        ) =>
          callback(
            data
          )
      ),

    onCalibrationComplete: callback =>
      ipcRenderer.on(
        "calibration:complete",
        (
          _event,
          data
        ) =>
          callback(
            data
          )
      ),

    onProjectorPattern: callback =>
      ipcRenderer.on(
        "projector:pattern",
        (
          _event,
          data
        ) =>
          callback(
            data
          )
      )
  }
);
