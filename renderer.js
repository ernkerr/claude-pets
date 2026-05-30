// Renderer entrypoint: sets up shared state, wires pet images, boots modules.

import { init as initBubble } from './bubble.js';
import { init as initPermissions } from './permissions.js';
import { init as initEditor } from './pet-editor.js';
import { init as initCoffee } from './coffee-modal.js';

const { session } = window.agent;

const DEFAULT_ICON = 'assets/default-pet.png';
const dog = document.getElementById('dog');
const dogImg = document.getElementById('dog-img');

// Shared mutable state — modules read/write this, rerender() syncs to DOM.
const state = {
  currentRequestId: null,
  lastMessage: '',
  lastActivity: '',
  pendingQuestion: null,
  userPinnedOpen: false,
  userDismissed: false,
  workingState: false,
  showingCompletion: false,
  verbose: false,
  playful: true,
  rerender: () => {},  // set by bubble.js init

  // Pet image state
  petImages: { idle: null, thinking: null, responseNeeded: null },
  currentPetState: 'idle',
  activePetId: null,

  updatePetImage(stateName) {
    if (stateName) state.currentPetState = stateName;
    const src = state.petImages[state.currentPetState]
      || state.petImages.idle
      || DEFAULT_ICON;
    dogImg.src = src;
  },
};

// --- load active pet ---
dog.title = session.path || session.name || '';

async function loadActivePet() {
  try {
    const pet = await window.agent.petsGetActive();
    if (pet) {
      state.activePetId = pet.id;
      state.petImages.idle = pet.resolvedStates.idle || DEFAULT_ICON;
      state.petImages.thinking = pet.resolvedStates.thinking || null;
      state.petImages.responseNeeded = pet.resolvedStates.responseNeeded || null;
      dog.classList.add('has-icon');
    }
  } catch {}
  state.updatePetImage('idle');
}
loadActivePet();

// Expose for pet-editor to call after changes
state.reloadPet = loadActivePet;

// --- manual drag (bypasses macOS menu-bar constraint) ---
dog.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.screenX;
  const startY = e.screenY;
  // Ask main process for current window position
  let winX = 0, winY = 0;
  // Use screenX/screenY relative to where the click started
  const onMove = (me) => {
    const dx = me.screenX - startX;
    const dy = me.screenY - startY;
    window.agent.setWindowPosition(winX + dx, winY + dy);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  // Get initial position synchronously via the window's screen offset
  // screenX/Y of the event minus clientX/Y gives window position
  winX = e.screenX - e.clientX;
  winY = e.screenY - e.clientY;
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// --- bubble resize grip ---
const resizeGrip = document.getElementById('resize-grip');
const MIN_W = 240;
const MIN_H = 360;
resizeGrip.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const startX = e.screenX;
  const startY = e.screenY;
  const startW = window.outerWidth;
  const startH = window.outerHeight;
  const onMove = (me) => {
    const newW = Math.max(MIN_W, startW + (me.screenX - startX));
    const newH = Math.max(MIN_H, startH + (me.screenY - startY));
    window.agent.resizeWindow(newW, newH);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// --- boot modules ---
initBubble(state);
initPermissions(state);
initEditor(state);
initCoffee();
