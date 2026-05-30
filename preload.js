const { contextBridge, ipcRenderer, webUtils } = require('electron');

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? decodeURIComponent(arg.slice(prefix.length)) : '';
}

const session = {
  id: readArg('session-id'),
  name: readArg('project-name'),
  path: readArg('project-path'),
  color: readArg('dog-color'),
};

contextBridge.exposeInMainWorld('agent', {
  session,
  onRequest: (cb) => ipcRenderer.on('approval:request', (_e, payload) => cb(payload)),
  respond: (requestId, choice, feedback) =>
    ipcRenderer.send('approval:response', {
      sessionId: session.id,
      requestId,
      choice,
      feedback: feedback || '',
    }),
  getIcon: () => ipcRenderer.invoke('icon:get', { sessionId: session.id }),
  uploadIcon: () => ipcRenderer.invoke('icon:upload', { sessionId: session.id }),
  resetIcon: () => ipcRenderer.invoke('icon:reset', { sessionId: session.id }),
  onPetEvent: (cb) => ipcRenderer.on('pet:event', (_e, payload) => cb(payload)),
  reply: (text) => ipcRenderer.send('pet:reply', { sessionId: session.id, text }),
  exitSession: () => ipcRenderer.send('session:exit', { sessionId: session.id }),
  resizeWindow: (width, height) => ipcRenderer.send('window:resize', { sessionId: session.id, width, height }),
  setWindowPosition: (x, y) => ipcRenderer.send('window:set-position', { sessionId: session.id, x, y }),
  showDiff: (diffData, title) => ipcRenderer.send('diff:show', { sessionId: session.id, diffData, title }),
  openExpandWindow: (text) => ipcRenderer.send('expand:open', { sessionId: session.id, text }),
  updateExpandWindow: (text) => ipcRenderer.send('expand:update', { sessionId: session.id, text }),
  closeExpandWindow: () => ipcRenderer.send('expand:close', { sessionId: session.id }),
  onExpandClosed: (cb) => ipcRenderer.on('expand:closed', () => cb()),

  // Pet store
  petsList: () => ipcRenderer.invoke('pets:list'),
  petsGetActive: () => ipcRenderer.invoke('pets:getActive'),
  petsSetActive: (petId) => ipcRenderer.send('pets:setActive', { petId }),
  petsAddEmpty: (name) => ipcRenderer.invoke('pets:addEmpty', { name }),
  petsRename: (petId, name) => ipcRenderer.invoke('pets:rename', { petId, name }),
  petsUploadState: (petId, stateName) =>
    ipcRenderer.invoke('pets:uploadState', { sessionId: session.id, petId, stateName }),
  getFilePath: (file) => webUtils.getPathForFile(file),
  petsDropState: (petId, stateName, filePath) =>
    ipcRenderer.invoke('pets:dropState', { petId, stateName, filePath }),
  petsRemoveState: (petId, stateName) =>
    ipcRenderer.invoke('pets:removeState', { petId, stateName }),
  petsSwapStates: (petId, fromState, toState) =>
    ipcRenderer.invoke('pets:swapStates', { petId, fromState, toState }),
  petsReorder: (fromId, toId) => ipcRenderer.invoke('pets:reorder', { fromId, toId }),
  petsDelete: (petId) => ipcRenderer.invoke('pets:delete', { petId }),
});
