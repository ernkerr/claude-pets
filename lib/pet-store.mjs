import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.join(__dirname, '..');

const STORE_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.claude-pets');
const STORE_FILE = path.join(STORE_DIR, 'pets.json');
const IMAGES_DIR = path.join(STORE_DIR, 'images');

const DEFAULT_PET = {
  id: 'default',
  name: 'Sausage Dog',
  builtIn: true,
  states: {
    idle: 'assets/default-pet.png',
    thinking: null,
    responseNeeded: null,
  },
};

function ensureDirs() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

export function loadStore() {
  ensureDirs();
  if (!fs.existsSync(STORE_FILE)) {
    const store = { activePetId: 'default', pets: [DEFAULT_PET] };
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    return store;
  }
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    // Ensure default pet always exists
    if (!store.pets.find((p) => p.id === 'default')) {
      store.pets.unshift(DEFAULT_PET);
    }
    return store;
  } catch {
    return { activePetId: 'default', pets: [DEFAULT_PET] };
  }
}

export function saveStore(store) {
  ensureDirs();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

export function getActivePet() {
  const store = loadStore();
  return store.pets.find((p) => p.id === store.activePetId) || store.pets[0];
}

export function setActivePetId(id) {
  const store = loadStore();
  if (store.pets.find((p) => p.id === id)) {
    store.activePetId = id;
    saveStore(store);
  }
}

export function savePetImage(buffer, ext) {
  ensureDirs();
  const id = crypto.randomBytes(8).toString('hex');
  const filename = `${id}.${ext}`;
  const absPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

export function addPet(name, imagePath) {
  const store = loadStore();
  const id = crypto.randomBytes(6).toString('hex');
  const pet = {
    id,
    name,
    builtIn: false,
    states: {
      idle: imagePath,
      thinking: null,
      responseNeeded: null,
    },
  };
  store.pets.push(pet);
  store.activePetId = id;
  saveStore(store);
  return pet;
}

export function updatePetState(petId, stateName, imagePath) {
  const store = loadStore();
  const pet = store.pets.find((p) => p.id === petId);
  if (!pet) return null;
  pet.states[stateName] = imagePath;
  saveStore(store);
  return pet;
}

export function removeStateImage(petId, stateName) {
  const store = loadStore();
  const pet = store.pets.find((p) => p.id === petId);
  if (!pet) return null;
  // Delete the file if it's in our images dir
  const imgPath = pet.states[stateName];
  if (imgPath && imgPath.startsWith(IMAGES_DIR)) {
    try { fs.unlinkSync(imgPath); } catch {}
  }
  pet.states[stateName] = null;
  saveStore(store);
  return pet;
}

export function swapStates(petId, fromState, toState) {
  if (fromState === toState) return null;
  const store = loadStore();
  const pet = store.pets.find((p) => p.id === petId);
  if (!pet) return null;
  const tmp = pet.states[fromState];
  pet.states[fromState] = pet.states[toState];
  pet.states[toState] = tmp;
  saveStore(store);
  return resolvePet(pet);
}

export function renamePet(petId, name) {
  const store = loadStore();
  const pet = store.pets.find((p) => p.id === petId);
  if (!pet || !name) return null;
  pet.name = name.trim();
  saveStore(store);
  return resolvePet(pet);
}

export function deletePet(petId) {
  const store = loadStore();
  const pet = store.pets.find((p) => p.id === petId);
  if (!pet || pet.builtIn) return false;
  // Delete associated image files
  for (const imgPath of Object.values(pet.states)) {
    if (imgPath && imgPath.startsWith(IMAGES_DIR)) {
      try { fs.unlinkSync(imgPath); } catch {}
    }
  }
  store.pets = store.pets.filter((p) => p.id !== petId);
  if (store.activePetId === petId) {
    store.activePetId = 'default';
  }
  saveStore(store);
  return true;
}

/** Resolve a pet image path to a file:// URL or data URL for the renderer. */
export function resolveImagePath(imgPath) {
  if (!imgPath) return null;
  // Absolute path (user image)
  if (path.isAbsolute(imgPath)) {
    if (!fs.existsSync(imgPath)) return null;
    return `file://${imgPath}`;
  }
  // Relative path (built-in asset) — resolve from app root
  const abs = path.join(APP_ROOT, imgPath);
  if (!fs.existsSync(abs)) return null;
  return `file://${abs}`;
}

/** Get the active pet with all image paths resolved to URLs. */
export function getActivePetResolved() {
  const pet = getActivePet();
  return resolvePet(pet);
}

/** Resolve all image paths in a pet to URLs. */
export function resolvePet(pet) {
  return {
    ...pet,
    resolvedStates: {
      idle: resolveImagePath(pet.states.idle),
      thinking: resolveImagePath(pet.states.thinking),
      responseNeeded: resolveImagePath(pet.states.responseNeeded),
    },
  };
}

/** Get all pets with resolved image URLs. */
export function listPetsResolved() {
  const store = loadStore();
  return {
    activePetId: store.activePetId,
    pets: store.pets.map(resolvePet),
  };
}
