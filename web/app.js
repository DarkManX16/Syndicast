/*
 * The page's bundle (web/public/bundle.js). Loaded by the page, it is the editor
 * (web/editor.js); loaded as a Web Worker, it runs a swap's re-lays off the
 * page's main thread (src/relay-worker.js, web/services/relay-worker.js) - one
 * bundle, so the worker is always built from the same code as the page.
 */
if (typeof(window) === 'undefined') {
    require('../src/relay-worker').listen(self);
} else {
    require('./editor');
}
