const { session } = window.agent;

const dog = document.getElementById('dog');
const statusPill = document.getElementById('status-pill');
const bubble = document.getElementById('bubble');
const permissionSection = document.getElementById('permission-section');
const messageSection = document.getElementById('message-section');
const inputSection = document.getElementById('input-section');
const msgText = document.getElementById('msg-text');
const expandBtn = document.getElementById('expand-btn');
const replyInput = document.getElementById('reply-input');
const sendBtn = document.getElementById('send-btn');
const pillVerboseCheckbox = document.getElementById('pill-verbose');
const pillPlayfulCheckbox = document.getElementById('pill-playful');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const btnUpload = document.getElementById('btn-upload');
const btnReset = document.getElementById('btn-reset');
const iconError = document.getElementById('icon-error');

// permission section refs
const title = document.getElementById('title');
const content = document.getElementById('content');
const optionsBox = document.getElementById('options');
const denyForm = document.getElementById('deny-form');
const denyFeedback = document.getElementById('deny-feedback');
const denySend = document.getElementById('deny-send');
const denyBack = document.getElementById('deny-back');
const queueHint = document.getElementById('queue-hint');

// ---------- pet appearance ----------
const DEFAULT_ICON = 'assets/default-pet.png';
const dogImg = document.getElementById('dog-img');
function paintBackground(iconDataUrl) {
  const src = iconDataUrl || DEFAULT_ICON;
  dogImg.src = src;
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

// ---------- state ----------
let lastMessage = '';
let isExpanded = false;
const PREVIEW_LEN = 280;

if (window.marked) {
  window.marked.setOptions({ breaks: true, gfm: true });
}
function renderMarkdown(el, text) {
  if (window.marked && window.DOMPurify) {
    el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
  } else {
    el.textContent = text;
  }
}

let currentRequestId = null;
let userPinnedOpen = false; // user explicitly opened bubble
let userDismissed = false;  // user explicitly hid bubble — reset on new content

let workingState = false; // true while a task is running
let lastActivity = '';   // latest tool activity text (literal description)

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
let showingCompletion = false;

// Toggles: "thinking out loud" shows activity in pill, "playful" makes it whimsical
let verbose = localStorage.getItem('pillVerbose') === 'true';
let playful = localStorage.getItem('pillPlayful') !== 'false'; // default true
pillVerboseCheckbox.checked = verbose;
pillPlayfulCheckbox.checked = playful;

function pickPhrase() {
  let next;
  do { next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]; }
  while (next === currentPhrase && THINKING_PHRASES.length > 1);
  currentPhrase = next;
}

function startPhraseRotation() {
  if (phraseTimer) return;
  pickPhrase();
  const scheduleNext = () => {
    phraseTimer = setTimeout(() => {
      pickPhrase();
      rerender();
      scheduleNext();
    }, 3000 + Math.random() * 2000);
  };
  scheduleNext();
}

function stopPhraseRotation() {
  if (phraseTimer) { clearTimeout(phraseTimer); phraseTimer = null; }
}

function showCompletionPhrase() {
  if (completionTimer) clearTimeout(completionTimer);
  currentPhrase = COMPLETION_PHRASES[Math.floor(Math.random() * COMPLETION_PHRASES.length)];
  showingCompletion = true;
  rerender();
  completionTimer = setTimeout(() => {
    showingCompletion = false;
    completionTimer = null;
    rerender();
  }, 3000);
}

pillVerboseCheckbox.onchange = () => {
  verbose = pillVerboseCheckbox.checked;
  localStorage.setItem('pillVerbose', verbose);
  if (workingState) {
    if (verbose && playful) startPhraseRotation();
    else stopPhraseRotation();
  }
  rerender();
};

pillPlayfulCheckbox.onchange = () => {
  playful = pillPlayfulCheckbox.checked;
  localStorage.setItem('pillPlayful', playful);
  if (workingState && verbose) {
    if (playful) startPhraseRotation();
    else stopPhraseRotation();
  }
  rerender();
};

function rerender() {
  const hasPermission = currentRequestId !== null;
  const hasMessage = lastMessage.length > 0;
  const showBubble = hasPermission || ((hasMessage || userPinnedOpen) && !userDismissed);

  bubble.classList.toggle('show', showBubble);
  permissionSection.classList.toggle('show', hasPermission);
  messageSection.classList.toggle('show', !hasPermission && hasMessage);
  inputSection.classList.toggle('show', !hasPermission);

  // Status pill
  statusPill.classList.remove('working', 'needs-response', 'completion');
  if (hasPermission) {
    statusPill.textContent = 'response needed';
    statusPill.classList.add('needs-response');
    replyInput.disabled = true;
    sendBtn.disabled = true;
  } else if (showingCompletion && verbose) {
    statusPill.textContent = currentPhrase;
    statusPill.classList.add('completion');
    replyInput.disabled = false;
    sendBtn.disabled = false;
  } else if (workingState) {
    if (verbose && playful) {
      statusPill.textContent = currentPhrase || 'thinking\u2026';
    } else if (verbose) {
      statusPill.textContent = lastActivity || 'thinking\u2026';
    } else {
      statusPill.textContent = 'thinking\u2026';
    }
    statusPill.classList.add('working');
    replyInput.disabled = true;
    sendBtn.disabled = true;
  } else {
    statusPill.textContent = 'idle';
    replyInput.disabled = false;
    sendBtn.disabled = false;
  }

  // Render message text with truncation
  if (hasMessage) {
    renderMarkdown(msgText, lastMessage);
    if (lastMessage.length <= PREVIEW_LEN) {
      msgText.classList.remove('expanded');
      expandBtn.style.display = 'none';
    } else if (isExpanded) {
      msgText.classList.add('expanded');
      expandBtn.style.display = 'inline-block';
      expandBtn.textContent = 'collapse';
    } else {
      msgText.classList.remove('expanded');
      expandBtn.style.display = 'inline-block';
      expandBtn.textContent = 'expand';
    }
  }
}
rerender();

expandBtn.onclick = () => {
  isExpanded = !isExpanded;
  rerender();
  if (isExpanded) msgText.scrollTop = msgText.scrollHeight;
};

// ---------- pill click: toggle bubble ----------
statusPill.addEventListener('click', () => {
  // Don't allow dismissing a pending permission.
  if (currentRequestId !== null) return;
  if (bubble.classList.contains('show')) {
    userDismissed = true;
    userPinnedOpen = false;
  } else {
    userDismissed = false;
    userPinnedOpen = true;
  }
  rerender();
});

// ---------- settings disclosure ----------
settingsToggle.onclick = () => {
  settingsPanel.classList.toggle('show');
};

// ---------- pet event handler ----------
window.agent.onPetEvent((event) => {
  if (event.type === 'status' && event.state === 'working') {
    workingState = true;
    if (verbose && playful) startPhraseRotation();
    rerender();
  } else if (event.type === 'tool-activity') {
    lastActivity = event.text;
    if (verbose && playful) pickPhrase();
    rerender();
  } else if (event.type === 'message') {
    lastMessage = event.text;
    lastActivity = '';
    isExpanded = false;
    userDismissed = false;
    workingState = false;
    stopPhraseRotation();
    if (verbose) showCompletionPhrase();
  } else if (event.type === 'status' && event.state === 'idle') {
    lastActivity = '';
    if (workingState) {
      workingState = false;
      stopPhraseRotation();
    }
    rerender();
  } else if (event.type === 'user-task') {
    lastMessage = '';
    lastActivity = '';
    isExpanded = false;
    if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
    showingCompletion = false;
    rerender();
  }
});

// ---------- send ----------
sendBtn.onclick = () => {
  const text = replyInput.value.trim();
  if (!text) return;
  window.agent.reply(text);
  replyInput.value = '';
  lastMessage = '';
  workingState = true;
  if (verbose && playful) startPhraseRotation();
  rerender();
};
replyInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendBtn.click();
});

// ---------- permission flow ----------
function showOptions() {
  optionsBox.style.display = 'block';
  denyForm.classList.remove('show');
  denyFeedback.value = '';
}
function showDenyForm() {
  optionsBox.style.display = 'none';
  denyForm.classList.add('show');
  setTimeout(() => denyFeedback.focus(), 0);
}

window.agent.onRequest(({ requestId, message, content: body, options, pendingCount }) => {
  currentRequestId = requestId;
  title.textContent = message || 'needs approval';
  if (body) {
    content.textContent = body;
    content.classList.add('show');
  } else {
    content.textContent = '';
    content.classList.remove('show');
  }
  optionsBox.innerHTML = '';
  (options || []).forEach((opt) => {
    const btn = document.createElement('button');
    btn.className = `opt ${opt.id}`;
    btn.textContent = opt.label;
    if (opt.id === 'deny') {
      btn.onclick = () => showDenyForm();
    } else {
      btn.onclick = () => respond(opt.id);
    }
    optionsBox.appendChild(btn);
  });
  showOptions();
  queueHint.textContent = pendingCount > 0 ? `+${pendingCount} more pending` : '';
  rerender();
});

function respond(choice, feedback) {
  if (!currentRequestId) return;
  window.agent.respond(currentRequestId, choice, feedback || '');
  currentRequestId = null;
  showOptions();
  queueHint.textContent = '';
  rerender();
}

// Number keys to select permission options
document.addEventListener('keydown', (e) => {
  if (!currentRequestId) return;
  if (denyForm.classList.contains('show')) return;
  const idx = parseInt(e.key, 10);
  if (idx >= 1 && idx <= optionsBox.children.length) {
    optionsBox.children[idx - 1].click();
  }
});

denySend.onclick = () => respond('deny', denyFeedback.value.trim());
denyBack.onclick = () => showOptions();
denyFeedback.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    respond('deny', denyFeedback.value.trim());
  }
});
