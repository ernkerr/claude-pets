// Buy Me a Coffee modal: shows once after the user has approved 10 tool calls.
// Approval count and dismissal flag live in localStorage so they persist across
// launches. Each renderer process has its own localStorage, so the count is
// per-pet-window — acceptable for a tip nudge.

const SEEN_KEY = 'coffeeModalSeen';
const COUNT_KEY = 'coffeeApprovalCount';
const THRESHOLD = 10;
const COFFEE_URL = 'https://buymeacoffee.com/ernkerr';

let modal, card, closeBtn, link;

export function init() {
  modal = document.getElementById('coffee-modal');
  card = modal.querySelector('.coffee-card');
  closeBtn = document.getElementById('coffee-close');
  link = document.getElementById('coffee-link');

  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  card.addEventListener('click', (e) => e.stopPropagation());
  link.addEventListener('click', (e) => {
    e.preventDefault();
    window.agent.openExternal(COFFEE_URL);
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('show')) close();
  });
}

export function bumpApprovalAndMaybeShow() {
  if (localStorage.getItem(SEEN_KEY) === 'true') return;
  const n = (parseInt(localStorage.getItem(COUNT_KEY) || '0', 10) || 0) + 1;
  localStorage.setItem(COUNT_KEY, String(n));
  if (n >= THRESHOLD) show();
}

function show() {
  if (!modal) return;
  modal.classList.add('show');
}

function close() {
  if (!modal) return;
  modal.classList.remove('show');
  localStorage.setItem(SEEN_KEY, 'true');
}
