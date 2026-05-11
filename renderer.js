// Renderer entrypoint: sets up shared state, wires pet images, boots modules.

import { init as initBubble } from './bubble.js';
import { init as initPermissions } from './permissions.js';
import { init as initEditor } from './pet-editor.js';

const { session } = window.agent;

const DEFAULT_ICON = 'assets/default-pet.png';
const dog = document.getElementById('dog');
const dogImg = document.getElementById('dog-img');

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

// --- boot modules ---
initBubble(state);
initPermissions(state);
initEditor(state);
