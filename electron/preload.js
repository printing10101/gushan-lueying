const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gushan', {
  readData: (name) => ipcRenderer.invoke('data:read', name),
  writeData: (name, content) => ipcRenderer.invoke('data:write', { name, content }),
  generateTrip: (input) => ipcRenderer.invoke('trip:generate', input),
  queryTrains: (fromStation, toStation, date) =>
    ipcRenderer.invoke('rail:query', { fromStation, toStation, date }),
  resolveStation: (keyword) => ipcRenderer.invoke('rail:resolveStation', keyword),
  drivingRoute: (from, to) => ipcRenderer.invoke('amap:drive', { from, to }),
  weatherForecast: (lng, lat, days) => ipcRenderer.invoke('weather:forecast', { lng, lat, days }),
});
