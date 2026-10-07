const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gushan', {
  readData: (name) => ipcRenderer.invoke('data:read', name),
  writeData: (name, content) => ipcRenderer.invoke('data:write', { name, content }),
  listTrips: () => ipcRenderer.invoke('trips:list'),
  deleteTrip: (id) => ipcRenderer.invoke('trips:delete', { id }),
  generateTrip: (input) => ipcRenderer.invoke('trip:generate', input),
  recommendTrails: (input) => ipcRenderer.invoke('trails:recommend', input),
  transportForTrail: (payload) => ipcRenderer.invoke('rail:transportForTrail', payload),
  runosState: (opts) => ipcRenderer.invoke('runos:state', opts),
  queryTrains: (fromStation, toStation, date) =>
    ipcRenderer.invoke('rail:query', { fromStation, toStation, date }),
  resolveStation: (keyword) => ipcRenderer.invoke('rail:resolveStation', keyword),
  weatherForecast: (lng, lat, days) => ipcRenderer.invoke('weather:forecast', { lng, lat, days }),
  exportTrip: (defaultName, markdown) => ipcRenderer.invoke('trip:export', { defaultName, markdown }),
  exportGpx: (tripId) => ipcRenderer.invoke('trip:exportGpx', { tripId }),
  importGpx: (payload) => ipcRenderer.invoke('gpx:import', payload),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
