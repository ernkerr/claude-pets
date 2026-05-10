// Renderer entrypoint: sets up shared state, wires pet icon, boots modules.

import { init as initBubble } from './bubble.js';
import { init as initPermissions } from './permissions.js';

const { session } = window.agent;

// Shared mutable state — modules read/write this, rerender() syncs to DOM.
const state = {
  currentRequestId: null,
  lastMessage: '',
  lastActivity: '',
  isExpanded: false,
  userPinnedOpen: false,
  userDismissed: false,
  workingState: false,
  showingCompletion: false,
  verbose: false,
  playful: true,
  rerender: () => {},  // set by bubble.js init
};

// --- pet icon ---
const DEFAULT_ICON = 'assets/default-pet.png';
const dog = document.getElementById('dog');
const dogImg = document.getElementById('dog-img');
const btnUpload = document.getElementById('btn-upload');
const btnReset = document.getElementById('btn-reset');
const iconError = document.getElementById('icon-error');

function paintBackground(iconDataUrl) {
  dogImg.src = iconDataUrl || DEFAULT_ICON;
  dog.classList.add('has-icon');
}
paintBackground(null);
dog.title = session.path || session.name || '';

window.agent.getIcon().then((icon) => { if (icon) paintBackground(icon); });

btnUpload.onclick = async () => {
  iconError.textContent = '';
  const result = await window.agent.uploadIcon();
  if (!result) return;
  if (result.error) { iconError.textContent = result.error; return; }
  paintBackground(result.icon);
};
btnReset.onclick = async () => {
  iconError.textContent = '';
  await window.agent.resetIcon();
  paintBackground(null);
};

// --- boot modules ---
initBubble(state);
initPermissions(state);
