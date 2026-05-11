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

  // Pet store
  petsList: () => ipcRenderer.invoke('pets:list'),
  petsGetActive: () => ipcRenderer.invoke('pets:getActive'),
  petsSetActive: (petId) => ipcRenderer.send('pets:setActive', { petId }),
  petsAdd: (name) => ipcRenderer.invoke('pets:add', { sessionId: session.id, name }),
  petsRename: (petId, name) => ipcRenderer.invoke('pets:rename', { petId, name }),
  petsUploadState: (petId, stateName) =>
    ipcRenderer.invoke('pets:uploadState', { sessionId: session.id, petId, stateName }),
  getFilePath: (file) => webUtils.getPathForFile(file),
  petsDropState: (petId, stateName, filePath) =>
    ipcRenderer.invoke('pets:dropState', { petId, stateName, filePath }),
  petsRemoveState: (petId, stateName) =>
    ipcRenderer.invoke('pets:removeState', { petId, stateName }),
  petsDelete: (petId) => ipcRenderer.invoke('pets:delete', { petId }),
});
