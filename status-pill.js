// Status pill: phrase rotation, verbose/playful toggles, completion flash.

// Phrases borrowed from lil-agents (https://github.com/ryanstephen/lil-agents)
const THINKING_PHRASES = [
  'hmm...', 'thinking...', 'one sec...', 'ok hold on',
  'let me check', 'working on it', 'almost...', 'bear with me',
  'on it!', 'gimme a sec', 'brb', 'processing...',
  'hang tight', 'just a moment', 'figuring it out',
  'crunching...', 'reading...', 'looking...',
  'cooking...', 'vibing...', 'digging in',
  'connecting dots', 'give me a sec',
  "don't rush me", 'calculating...', 'assembling\u2026',
];
const COMPLETION_PHRASES = [
  'done!', 'all set!', 'ready!', 'here you go', 'got it!',
  'finished!', 'ta-da!', 'voila!',
  'boom!', 'there ya go!', 'check it out!',
];

let currentPhrase = '';
let phraseTimer = null;
let completionTimer = null;

export function pickPhrase() {
  let next;
  do { next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]; }
  while (next === currentPhrase && THINKING_PHRASES.length > 1);
  currentPhrase = next;
}

export function startPhraseRotation(state) {
  if (phraseTimer) return;
  pickPhrase();
  const scheduleNext = () => {
    phraseTimer = setTimeout(() => {
      pickPhrase();
      state.rerender();
      scheduleNext();
    }, 3000 + Math.random() * 2000);
  };
  scheduleNext();
}

export function stopPhraseRotation() {
  if (phraseTimer) { clearTimeout(phraseTimer); phraseTimer = null; }
}

export function showCompletionPhrase(state) {
  if (completionTimer) clearTimeout(completionTimer);
  currentPhrase = COMPLETION_PHRASES[Math.floor(Math.random() * COMPLETION_PHRASES.length)];
  state.showingCompletion = true;
  state.rerender();
  completionTimer = setTimeout(() => {
    state.showingCompletion = false;
    completionTimer = null;
    state.rerender();
  }, 3000);
}

export function clearCompletionTimer(state) {
  if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
  state.showingCompletion = false;
}

export function renderPill(el, state) {
  el.classList.remove('working', 'needs-response', 'completion');
  if (state.currentRequestId !== null) {
    el.textContent = 'response needed';
    el.classList.add('needs-response');
  } else if (state.showingCompletion && state.verbose) {
    el.textContent = currentPhrase;
    el.classList.add('completion');
  } else if (state.workingState) {
    if (state.verbose && state.playful) {
      el.textContent = currentPhrase || 'thinking\u2026';
    } else if (state.verbose) {
      el.textContent = state.lastActivity || 'thinking\u2026';
    } else {
      el.textContent = 'thinking\u2026';
    }
    el.classList.add('working');
  } else {
    el.textContent = 'idle';
  }
}

export function initToggles(pillVerboseCheckbox, pillPlayfulCheckbox, state) {
  state.verbose = localStorage.getItem('pillVerbose') === 'true';
  state.playful = localStorage.getItem('pillPlayful') !== 'false';
  pillVerboseCheckbox.checked = state.verbose;
  pillPlayfulCheckbox.checked = state.playful;

  pillVerboseCheckbox.onchange = () => {
    state.verbose = pillVerboseCheckbox.checked;
    localStorage.setItem('pillVerbose', state.verbose);
    if (state.workingState) {
      if (state.verbose && state.playful) startPhraseRotation(state);
      else stopPhraseRotation();
    }
    state.rerender();
  };

  pillPlayfulCheckbox.onchange = () => {
    state.playful = pillPlayfulCheckbox.checked;
    localStorage.setItem('pillPlayful', state.playful);
    if (state.workingState && state.verbose) {
      if (state.playful) startPhraseRotation(state);
      else stopPhraseRotation();
    }
    state.rerender();
  };
}
