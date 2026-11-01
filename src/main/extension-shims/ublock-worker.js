// Olive entry point for uBO Lite's service worker: install the API shim, then
// run the unmodified background.js. Module imports evaluate in order.
import './worker-shim.js';
import '../js/background.js';
