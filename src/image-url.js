/*
 * Channel images (icon, offline picture, watermark) are stored as paths such as
 * "/images/dizquetv.png" rather than full URLs, so they survive the server
 * moving to a different port or host.
 *
 * Consumers resolve them differently: clients need an address they can reach,
 * while ffmpeg runs on this machine and cannot resolve a client's hostname.
 */

function isStoredPath(value) {
    return (typeof(value) === 'string') && value.startsWith('/');
}

// For XMLTV and M3U output, where {{host}} is substituted per request from the
// address the client actually used to reach us.
function forClient(value) {
    return isStoredPath(value) ? `{{host}}${value}` : value;
}

function forLocalFfmpeg(value) {
    return isStoredPath(value) ? `http://localhost:${process.env.PORT}${value}` : value;
}

module.exports = {
    isStoredPath: isStoredPath,
    forClient: forClient,
    forLocalFfmpeg: forLocalFfmpeg,
};
