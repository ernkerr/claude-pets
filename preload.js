const { contextBridge, ipcRenderer } = require('electron');

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
  onPetEvent: (cb) => ipcRenderer.on('pet:event', (_e, payload) => cb(payload)),
  reply: (text) => ipcRenderer.send('pet:reply', { sessionId: session.id, text }),

  pets: {
    list: () => ipcRenderer.invoke('pets:list', { sessionId: session.id }),
    select: (petId) => ipcRenderer.invoke('pets:select', { sessionId: session.id, petId }),
    create: (name) => ipcRenderer.invoke('pets:create', { sessionId: session.id, name }),
    rename: (petId, name) => ipcRenderer.invoke('pets:rename', { petId, name }),
    remove: (petId) => ipcRenderer.invoke('pets:remove', { petId }),
    uploadState: (petId, stateKey) =>
      ipcRenderer.invoke('pets:upload-state', { sessionId: session.id, petId, stateKey }),
    removeState: (petId, stateKey) => ipcRenderer.invoke('pets:remove-state', { petId, stateKey }),
    setAnim: (petId, stateKey, params) =>
      ipcRenderer.invoke('pets:set-anim', { petId, stateKey, ...params }),
    onChanged: (cb) => ipcRenderer.on('pets:changed', (_e, payload) => cb(payload)),
  },
});
