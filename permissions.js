// Permission flow: approval requests, option buttons, deny form, keyboard shortcuts.

export function init(state) {
  const title = document.getElementById('title');
  const content = document.getElementById('content');
  const summaryEl = document.getElementById('summary');
  const summaryExpand = document.getElementById('summary-expand');
  const diffToggle = document.getElementById('diff-toggle');
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
    state.updatePetImage(state.workingState ? 'thinking' : 'idle');
    state.rerender();
  }

  window.agent.onRequest(({ requestId, message, content: body, options, pendingCount, diffData, summary }) => {
    state.currentRequestId = requestId;
    state.updatePetImage('responseNeeded');
    title.textContent = message || 'needs approval';
    if (body) {
      content.textContent = body;
      content.classList.add('show');
    } else {
      content.textContent = '';
      content.classList.remove('show');
    }

    // Summary from Claude's last assistant message
    summaryEl.textContent = summary || '';
    if (summary && summaryEl.scrollHeight > summaryEl.clientHeight + 1) {
      summaryExpand.classList.add('show');
      summaryExpand.onclick = () => window.agent.openExpandWindow(summary);
    } else {
      // Use scrollHeight at next frame in case layout isn't ready yet.
      summaryExpand.classList.remove('show');
      summaryExpand.onclick = null;
      requestAnimationFrame(() => {
        if (summary && summaryEl.scrollHeight > summaryEl.clientHeight + 1) {
          summaryExpand.classList.add('show');
          summaryExpand.onclick = () => window.agent.openExpandWindow(summary);
        }
      });
    }

    // Diff toggle — opens a separate window
    const hasDiff = diffData && (
      (diffData.type === 'edit' && (diffData.oldString || diffData.newString)) ||
      (diffData.type === 'write' && diffData.writeContent)
    );

    if (hasDiff) {
      diffToggle.classList.add('show');
      diffToggle.textContent = 'Show Diff';
      diffToggle.onclick = () => {
        window.agent.showDiff(diffData, message || '');
      };
    } else {
      diffToggle.classList.remove('show');
      diffToggle.onclick = null;
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
