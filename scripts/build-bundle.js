/*
 * `npm run build`: builds web/public/bundle.js the way the server does when it finds the
 * bundle stale (src/web-bundle.js) - stamped with the commit it was built from, and with a
 * build record, so a server started afterwards doesn't rebuild it again on its first request.
 */
const path = require('path');
const { appBundleChecker } = require('../src/web-bundle');

appBundleChecker(path.join(__dirname, '..'))._rebuild({ reason: 'npm run build', signature: 'npm run build' })
    .then((ok) => { process.exitCode = ok ? 0 : 1; });
