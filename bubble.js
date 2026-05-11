// Bubble: message display, expand/collapse, reply input, event dispatch.

import {
  startPhraseRotation, stopPhraseRotation,
  showCompletionPhrase, clearCompletionTimer,
  pickPhrase, renderPill, initToggles,
} from './status-pill.js';

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

export function init(state) {
  const statusPill = document.getElementById('status-pill');
  const bubble = document.getElementById('bubble');
  const permissionSection = document.getElementById('permission-section');
  const messageSection = document.getElementById('message-section');
  const inputSection = document.getElementById('input-section');
  const msgText = document.getElementById('msg-text');
  const expandBtn = document.getElementById('expand-btn');
  const replyInput = document.getElementById('reply-input');
  const sendBtn = document.getElementById('send-btn');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');

  const PREVIEW_LEN = 280;

  initToggles(
    document.getElementById('pill-verbose'),
    document.getElementById('pill-playful'),
    state,
  );

  // --- rerender: the single function that syncs DOM to state ---
  state.rerender = () => {
    const hasPermission = state.currentRequestId !== null;
    const hasMessage = state.lastMessage.length > 0;
    const showBubble = hasPermission || ((hasMessage || state.userPinnedOpen) && !state.userDismissed);

    bubble.classList.toggle('show', showBubble);
    permissionSection.classList.toggle('show', hasPermission);
    messageSection.classList.toggle('show', !hasPermission && hasMessage);
    inputSection.classList.toggle('show', !hasPermission);

    renderPill(statusPill, state);

    const inputDisabled = hasPermission || state.workingState;
    replyInput.disabled = inputDisabled;
    sendBtn.disabled = inputDisabled;

    if (hasMessage) {
      renderMarkdown(msgText, state.lastMessage);
      if (state.lastMessage.length <= PREVIEW_LEN) {
        msgText.classList.remove('expanded');
        expandBtn.style.display = 'none';
      } else if (state.isExpanded) {
        msgText.classList.add('expanded');
        expandBtn.style.display = 'inline-block';
        expandBtn.textContent = 'collapse';
      } else {
        msgText.classList.remove('expanded');
        expandBtn.style.display = 'inline-block';
        expandBtn.textContent = 'expand';
      }
    }
  };

  // --- expand/collapse ---
  expandBtn.onclick = () => {
    state.isExpanded = !state.isExpanded;
    state.rerender();
    if (state.isExpanded) msgText.scrollTop = msgText.scrollHeight;
  };

  // --- pill click: toggle bubble ---
  statusPill.addEventListener('click', () => {
    if (state.currentRequestId !== null) return;
    if (bubble.classList.contains('show')) {
      state.userDismissed = true;
      state.userPinnedOpen = false;
    } else {
      state.userDismissed = false;
      state.userPinnedOpen = true;
    }
    state.rerender();
  });

  // --- settings ---
  settingsToggle.onclick = () => settingsPanel.classList.toggle('show');

  // --- pet events ---
  function derivePetState() {
    if (state.currentRequestId !== null) return 'responseNeeded';
    if (state.workingState) return 'thinking';
    return 'idle';
  }

  window.agent.onPetEvent((event) => {
    if (event.type === 'status' && event.state === 'working') {
      state.workingState = true;
      if (state.verbose && state.playful) startPhraseRotation(state);
      state.updatePetImage(derivePetState());
      state.rerender();
    } else if (event.type === 'tool-activity') {
      state.lastActivity = event.text;
      if (state.verbose && state.playful) pickPhrase();
      state.rerender();
    } else if (event.type === 'message') {
      state.lastMessage = event.text;
      state.lastActivity = '';
      state.isExpanded = false;
      state.userDismissed = false;
      state.workingState = false;
      stopPhraseRotation();
      state.updatePetImage(derivePetState());
      if (state.verbose) showCompletionPhrase(state);
      else state.rerender();
    } else if (event.type === 'status' && event.state === 'idle') {
      state.lastActivity = '';
      if (state.workingState) {
        state.workingState = false;
        stopPhraseRotation();
      }
      state.updatePetImage(derivePetState());
      state.rerender();
    } else if (event.type === 'user-task') {
      state.lastMessage = '';
      state.lastActivity = '';
      state.isExpanded = false;
      clearCompletionTimer(state);
      state.updatePetImage('idle');
      state.rerender();
    }
  });

  // --- send ---
  sendBtn.onclick = () => {
    const text = replyInput.value.trim();
    if (!text) return;
    window.agent.reply(text);
    replyInput.value = '';
    state.lastMessage = '';
    state.workingState = true;
    if (state.verbose && state.playful) startPhraseRotation(state);
    state.updatePetImage('thinking');
    state.rerender();
  };
  replyInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendBtn.click();
  });

  state.rerender();
}
