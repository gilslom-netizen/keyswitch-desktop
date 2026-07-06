// health-server.js - KeySwitch Desktop
// =============================================================================
// A tiny loopback-only HTTP server whose ONLY purpose is to let the KeySwitch
// Chrome extension detect that the desktop app is running on the same machine,
// so the two never both auto-correct the same keystroke (which would double-
// correct / corrupt text — see the coordination note in the extension's
// background.js and autocorrect.js).
//
// Why this approach: a Chrome content script / service worker is sandboxed and
// cannot see OS processes or the filesystem, so it can't directly tell whether
// the native app is installed. The one thing it CAN do is fetch a localhost
// URL. So the desktop app exposes a single read-only health endpoint on
// loopback, the extension polls it, and when it answers the extension stands
// down (the desktop app is the more capable of the two — it also works on
// blocked pages, canvas editors, and outside the browser entirely).
//
// Security posture (deliberately minimal):
//   * Bound to 127.0.0.1 ONLY — never reachable from the network.
//   * Exactly one route, GET /keyswitch-health, returning a fixed JSON blob
//     ({ running, version }). No input is parsed, nothing is written, no other
//     capability exists — there is no attack surface beyond "is it up".
//   * CORS is open (*) because the payload is non-sensitive (just a liveness
//     flag + version) and the extension's origin is a chrome-extension:// URL
//     that would otherwise be awkward to allowlist across dev/prod IDs.
// =============================================================================
'use strict';

const http = require('http');

// Fixed high port in the IANA dynamic range, unlikely to collide. Must match
// the URL the extension polls (background.js: DESKTOP_HEALTH_URL).
const HEALTH_PORT = 47653;
const HEALTH_PATH = '/keyswitch-health';

function startHealthServer(getInfo) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === HEALTH_PATH) {
      const body = JSON.stringify(Object.assign({ running: true }, getInfo ? getInfo() : {}));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // A second instance (or anything else already on the port) must never crash
  // the app — single-instance lock means normally only one server ever runs,
  // and if the port is somehow taken we simply skip the health signal.
  server.on('error', (err) => {
    console.error('[KeySwitch] health server error:', err && err.message);
  });

  try {
    server.listen(HEALTH_PORT, '127.0.0.1');
  } catch (e) {
    console.error('[KeySwitch] health server failed to start:', e);
  }
  return server;
}

module.exports = { startHealthServer, HEALTH_PORT, HEALTH_PATH };
