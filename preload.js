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
  getIcon: () => ipcRenderer.invoke('icon:get', { sessionId: session.id }),
  uploadIcon: () => ipcRenderer.invoke('icon:upload', { sessionId: session.id }),
  resetIcon: () => ipcRenderer.invoke('icon:reset', { sessionId: session.id }),
  onPetEvent: (cb) => ipcRenderer.on('pet:event', (_e, payload) => cb(payload)),
  reply: (text) => ipcRenderer.send('pet:reply', { sessionId: session.id, text }),
});
