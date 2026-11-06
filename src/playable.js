/*
 * Whether the file an item plays from can be opened, asked by video.js before
 * the item is handed to a player.
 *
 * Nov 5, 2026: a NEXT bumper on a USB drive couldn't be opened for a moment,
 * and plexTranscoder.js's check for it threw where nothing could catch it,
 * taking the whole server and every channel down. Now /stream asks here
 * first, and an item that can't be opened is skipped: a Flex clip for the next
 * pick, a step for what follows it, a program for the channel's Flex in its
 * slot (video.js does the skipping).
 *
 * Only files Syndicast opens itself are checked: a generated card, and a Plex
 * item when Plex's direct paths are on. With Plex streaming the file, Plex
 * opens it, and a failure there plays the error screen as before.
 *
 * A file that couldn't be opened is remembered for REMEMBER_MS, so the Flex
 * picker leaves it out and a program's slot doesn't ask the drive again for
 * every clip played in its place. After that it is tried again: a drive that
 * comes back is used again without a restart.
 */
const fs = require('fs');

const OPEN_TIMEOUT_MS = 5 * 1000;
const REMEMBER_MS = 5 * 60 * 1000;

let unopenable = new Map();   // file -> { why, until }

// The file a player would open for item, or null when that isn't Syndicast.
function fileOf(item, plexSettings) {
    if ( (item == null) || (typeof(item) !== 'object') ) {
        return null;
    }
    if (typeof(item.generatedFile) === 'string') {
        return item.generatedFile;
    }
    if ( (item.isOffline === true) || (typeof(item.err) !== 'undefined') ) {
        return null;
    }
    if ( (plexSettings != null) && (plexSettings.streamPath === 'direct') && (typeof(item.file) === 'string') ) {
        // as plexTranscoder.js maps it
        return item.file.replace(plexSettings.pathReplace, plexSettings.pathReplaceWith);
    }
    return null;
}

function known(file, now) {
    let held = unopenable.get(file);
    if (typeof(held) === 'undefined') {
        return null;
    }
    if (held.until <= now) {
        unopenable.delete(file);
        return null;
    }
    return held.why;
}

// Opens and closes file, or fails; a drive that doesn't answer fails after ms.
function openWithin(file, ms) {
    return new Promise( (resolve, reject) => {
        let settled = false;
        let timer = setTimeout( () => {
            settled = true;
            reject( Error(`no answer in ${ms / 1000}s`) );
        }, ms);
        fs.promises.open(file, 'r').then( (handle) => {
            handle.close().catch( () => {} );
            if (! settled) {
                settled = true;
                clearTimeout(timer);
                resolve();
            }
        }, (err) => {
            if (! settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        } );
    } );
}

/*
 * null if file opens, or why it doesn't ("ENOENT: no such file or directory").
 * Never rejects.
 */
async function whyNot(file, now) {
    let held = known(file, now);
    if (held !== null) {
        return held;
    }
    try {
        await openWithin(file, OPEN_TIMEOUT_MS);
        return null;
    } catch (err) {
        let why = String( (err && err.message) || err ).replace(/, open '.*'$/s, '');
        unopenable.set(file, { why: why, until: now + REMEMBER_MS });
        return why;
    }
}

function isKnownUnopenable(item, plexSettings, now) {
    let file = fileOf(item, plexSettings);
    return (file !== null) && (known(file, now) !== null);
}

/*
 * The filler lists fillerService gave, less any clip known not to open. The
 * lists themselves are fillerService's cached copies, so a list that loses a
 * clip is copied, never changed.
 */
function withoutUnopenable(fillers, plexSettings, now) {
    if ( (unopenable.size === 0) || ! Array.isArray(fillers) ) {
        return fillers;
    }
    return fillers.map( (list) => {
        if ( (list == null) || ! Array.isArray(list.content) ) {
            return list;
        }
        let content = list.content.filter( (clip) => ! isKnownUnopenable(clip, plexSettings, now) );
        return (content.length === list.content.length) ? list : Object.assign( {}, list, { content: content } );
    } );
}

module.exports = {
    OPEN_TIMEOUT_MS: OPEN_TIMEOUT_MS,
    REMEMBER_MS: REMEMBER_MS,
    fileOf: fileOf,
    whyNot: whyNot,
    isKnownUnopenable: isKnownUnopenable,
    withoutUnopenable: withoutUnopenable,
    forget: () => { unopenable = new Map(); },
};
