// welcome.js - KeySwitch Desktop first-run welcome screen
'use strict';

const ks = window.keyswitch;

// The two "try it" buttons open in the system browser (never navigate this
// window — see the navigation guard in main.js).
document.querySelectorAll('.link-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const url = btn.getAttribute('data-url');
    if (url) ks.openExternal(url);
  });
});

// Pin-to-taskbar button. Windows deliberately blocks programmatic pinning
// (there is no supported API), and the old code called ks.pinToTaskbar() —
// which was never exposed by the preload — so clicking threw a TypeError and
// silently did nothing. Show the 10-second manual way instead.
const pinBtn = document.getElementById('pinBtn');
if (pinBtn) {
  pinBtn.addEventListener('click', () => {
    const tip = pinBtn.closest('.tip');
    if (!tip || tip.querySelector('.pin-howto')) return;
    const howto = document.createElement('div');
    howto.className = 'tip-body pin-howto';
    howto.style.marginTop = '8px';
    howto.style.color = '#7eb8f7';
    howto.textContent = 'חפשו "KeySwitch" בתפריט התחל, לחצו קליק ימני על התוצאה ובחרו "הצמד לשורת המשימות".';
    tip.appendChild(howto);
  });
}

document.getElementById('doneBtn').addEventListener('click', () => {
  ks.closeWelcome();
});
