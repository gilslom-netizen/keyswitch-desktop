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

document.getElementById('doneBtn').addEventListener('click', () => {
  ks.closeWelcome();
});
