// toast.js - KeySwitch Desktop toast overlay
'use strict';

const ks = window.keyswitch;

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

  if (data.type === 'auto') {
    // Intentionally generic, like the browser extension's auto-detect toast:
    // this fires with zero user action during normal typing, so it must never
    // show the actual text (it could be a password/passphrase typed in the
    // wrong layout) — main.js doesn't even send it over IPC for this type.
    // One sentence, no separate body text.
    const langName = data.targetLang === 'he' ? 'עברית' : 'אנגלית';
    titleEl.textContent = `נראה שהתכוונת לכתוב ב${langName}. KeySwitch תיקן אוטומטית.`;
    bodyEl.innerHTML = '';
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
    const h = document.getElementById('toast').getBoundingClientRect().height;
    ks.toastResize(h + 8);
  });
});
