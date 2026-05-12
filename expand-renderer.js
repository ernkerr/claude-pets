if (window.marked) {
  window.marked.setOptions({ breaks: true, gfm: true });
}

const content = document.getElementById('content');

window.expandAPI.onUpdate(({ text }) => {
  if (window.marked && window.DOMPurify) {
    content.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text));
  } else {
    content.textContent = text;
  }
});

window.addEventListener('beforeunload', () => {
  window.expandAPI.reportSize(window.outerWidth, window.outerHeight);
});
