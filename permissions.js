// Permission flow: approval requests, option buttons, deny form, keyboard shortcuts.

export function init(state) {
  const title = document.getElementById('title');
  const content = document.getElementById('content');
  const optionsBox = document.getElementById('options');
  const denyForm = document.getElementById('deny-form');
  const denyFeedback = document.getElementById('deny-feedback');
  const denySend = document.getElementById('deny-send');
  const denyBack = document.getElementById('deny-back');
  const queueHint = document.getElementById('queue-hint');

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

  function respond(choice, feedback) {
    if (!state.currentRequestId) return;
    window.agent.respond(state.currentRequestId, choice, feedback || '');
    state.currentRequestId = null;
    showOptions();
    queueHint.textContent = '';
    state.rerender();
  }

  window.agent.onRequest(({ requestId, message, content: body, options, pendingCount }) => {
    state.currentRequestId = requestId;
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
    state.rerender();
  });

  document.addEventListener('keydown', (e) => {
    if (!state.currentRequestId) return;
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
}
