// toast.js - KeySwitch Desktop toast overlay
'use strict';

const ks = window.keyswitch;

const toastEl = document.getElementById('toast');
const titleEl = document.getElementById('toastTitle');
const bodyEl = document.getElementById('toastBody');
const revertBtn = document.getElementById('revertBtn');
const footerEl = document.getElementById('toastFooter');

document.getElementById('closeBtn').addEventListener('click', () => ks.toastAction('close'));
revertBtn.addEventListener('click', () => ks.toastAction('revert'));
document.getElementById('disableAuto').addEventListener('click', () => ks.toastAction('disable-auto'));
document.getElementById('hideAutoToast').addEventListener('click', () => ks.toastAction('hide-auto-toast'));

function trim(s, n) {
  const clean = (s || '').replace(/[\n\r]+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 3) + '...' : clean;
}

ks.onToastShow((data) => {
  revertBtn.style.display = 'none';
  footerEl.style.display = 'none';
  // 'auto' toast is semi-transparent and brightens on hover, exactly like the
  // browser extension's auto-detect toast; every other toast is fully opaque.
  document.body.classList.toggle('is-auto', data.type === 'auto');

  if (data.type === 'auto') {
    // Matches the extension's auto-detect toast: a generic title (never the
    // corrected text itself — it could be a password mistyped in the wrong
    // layout; main.js doesn't even send it), the revert action, and the
    // disable/hide footer links. Body wording is adapted for the desktop,
    // which SWITCHES the keyboard layout rather than live-remapping keystrokes.
    titleEl.textContent = 'זוהתה שפה שגויה ⌨️';
    bodyEl.innerHTML = '';
    const body = document.createElement('div');
    body.textContent = 'תיקנו את המילה אוטומטית והחלפנו את שפת המקלדת.';
    bodyEl.appendChild(body);
    revertBtn.style.display = 'block';
    footerEl.style.display = 'flex';
  } else if (data.type === 'manual') {
    titleEl.textContent = '🔄 KeySwitch — הטקסט הוחלף';
    bodyEl.innerHTML = '';
    const orig = document.createElement('span'); orig.className = 'orig'; orig.textContent = trim(data.original, 80);
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '←';
    const conv = document.createElement('span'); conv.className = 'conv'; conv.textContent = trim(data.converted, 80);
    bodyEl.append(orig, arrow, conv);
  } else {
    titleEl.textContent = 'ℹ️ KeySwitch';
    bodyEl.textContent = data.text || '';
  }

  requestAnimationFrame(() => {
    const h = toastEl.getBoundingClientRect().height;
    ks.toastResize(h + 8);
  });
});
