const path = require('path');
var fs = require('fs');

/*
 * A channel file that will not parse is retried rather than treated as missing,
 * because it far more likely means the file is being replaced right now than that
 * it is corrupt. saveChannel writes with fs.writeFile, which truncates the target
 * first, so a read landing inside that window gets a partial file - and channel
 * JSON is large enough for the window to be wide. Measured against the 27MB
 * channel in the dev data folder, 26 of 72 concurrent reads came back
 * unparseable. getChannel returned null for those, and every consumer reads null
 * as "channel doesn't exist", so a torn read surfaced as a 404 on a live stream
 * rather than as anything traceable.
 *
 * This was previously hidden rather than absent: channelCache.saveChannelConfig
 * repopulated the config cache before the write, so concurrent readers got a
 * cache hit and never reached the file at all. It now invalidates instead, which
 * is correct on a rejected save but does send readers to disk during the write.
 *
 * Writing to a temporary file and renaming over the target would close the window
 * rather than wait it out, and is the usual answer, but it does not work here: on
 * Windows rename fails with EPERM while any reader holds the destination open,
 * and under a steady stream of readers it never gets a gap. Measured at 0 of 10
 * renames succeeding with retries out to 200ms. So the window stays and the
 * reader waits it out instead.
 *
 * The ladder is shaped to outlast a large channel's write. A file that really is
 * corrupt costs the whole of it before returning null, which is what this
 * returned immediately before - a broken state either way, and the wait does not
 * make it worse.
 */
const READ_RETRY_DELAYS = [5, 10, 25, 50, 100, 200, 400, 800];

function readChannelFile(f) {
    return new Promise( (resolve, reject) => {
        fs.readFile(f, (err, data) => {
            if (err) {
                return reject(err);
            }
            try {
                resolve( JSON.parse(data) )
            } catch (parseErr) {
                reject(parseErr);
            }
        })
    });
}

/*
 * Channel images are stored as paths like "/images/dizquetv.png" so they
 * survive the server moving, and src/image-url.js resolves them per consumer.
 * Twice now a writer has stored an absolute URL instead: first the UI building
 * one from location.host, then the upload endpoint building one from the
 * request's host. Both went unnoticed for months, because nothing complains -
 * the resolvers pass an absolute value straight through, by design, so that
 * Plex thumbnail URLs keep working.
 *
 * So complain here. Every channel write goes through validateChannelJson, which
 * makes this the one place that sees them all. It is a string check that
 * rewrites nothing: correcting the value here would have to guess whether a
 * remote URL under /images/ is stale or deliberate, and guessing wrong silently
 * serves the wrong image. Being loud is the whole job.
 */
function warnAboutAbsoluteImages(json) {
    const fields = [
        [ 'icon', json.icon ],
        [ 'offlinePicture', json.offlinePicture ],
        [ 'watermark.url', (json.watermark || {}).url ],
    ];
    for (const [name, value] of fields) {
        if (typeof(value) !== 'string') {
            continue;
        }
        let parsed;
        try {
            parsed = new URL(value);
        } catch (err) {
            continue;   // a stored path, which is what we want
        }
        if (! parsed.pathname.startsWith('/images/') ) {
            continue;   // some other host's image, deliberately left alone
        }
        console.error(
            `Channel ${json.number}: ${name} was saved as an absolute URL, `
            + `"${value}". It should be the path "${parsed.pathname}". Whatever `
            + `wrote it has pinned this image to one address, and clients on any `
            + `other address will not be able to load it.`
        );
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/*
 * Day-parts form one continuous weekly chain, so a malformed start does not
 * fail loudly on its own - it just makes some stretch of the week resolve to a
 * day-part nobody meant. Complain here, at the one place every channel write
 * passes through, for the same reason the image check above lives here.
 *
 * Warn-only, and it rewrites nothing. A start that cannot be parsed is ignored
 * by the resolver, which is the conservative answer; guessing what was meant
 * would silently play the wrong filler for hours.
 */
function warnAboutDayParts(json) {
    if (typeof(json.dayParts) === 'undefined') {
        return;
    }
    const complain = (message) => {
        console.error(`Channel ${json.number}: ${message}`);
    };
    if (! Array.isArray(json.dayParts) ) {
        complain(`dayParts was saved as ${typeof(json.dayParts)} rather than an array. It will be ignored and the channel's Flex tab used instead.`);
        return;
    }
    let seenStarts = {};
    for (let i = 0; i < json.dayParts.length; i++) {
        const dayPart = json.dayParts[i];
        const label = `day-part ${i}` + ( (dayPart != null) && dayPart.name ? ` ("${dayPart.name}")` : '' );
        if (dayPart == null) {
            complain(`${label} is empty.`);
            continue;
        }
        if (! Array.isArray(dayPart.starts) || (dayPart.starts.length === 0) ) {
            complain(`${label} has no start times, so it never airs.`);
            continue;
        }
        for (let j = 0; j < dayPart.starts.length; j++) {
            const start = dayPart.starts[j];
            if (start == null) {
                complain(`${label} start ${j} is empty.`);
                continue;
            }
            if (! Array.isArray(start.days) || (start.days.length === 0) ) {
                complain(`${label} start ${j} names no days, so it never airs.`);
                continue;
            }
            if ( (typeof(start.time) !== 'number')
                || isNaN(start.time)
                || (start.time < 0)
                || (start.time >= DAY_MS)
            ) {
                complain(`${label} start ${j} has time ${start.time}, which should be a number of milliseconds from midnight between 0 and ${DAY_MS - 1}. It will be ignored.`);
                continue;
            }
            for (const day of start.days) {
                if ( (typeof(day) !== 'number') || ! Number.isInteger(day) || (day < 0) || (day > 6) ) {
                    complain(`${label} start ${j} names day ${day}, which should be an integer from 0 (Sunday) to 6. It will be ignored.`);
                    continue;
                }
                const key = `${day}|${start.time}`;
                if (typeof(seenStarts[key]) !== 'undefined') {
                    complain(`${label} starts at the same moment as ${seenStarts[key]} (day ${day}, ${start.time}ms). The chain cannot run two day-parts at once, so the one declared first wins and the other never airs at that time.`);
                    continue;
                }
                seenStarts[key] = label;
            }
        }
    }
}

/*
 * Blocks, warned about at the same write boundary and for the same reason as
 * day-parts above. The one check day-parts doesn't need: airings of two
 * different blocks may not overlap, per the spec - the editor is meant to
 * prevent this interactively, but this is the one place every write passes
 * through regardless of how it got here (a hand-edited channel file, an API
 * write), so it needs its own check rather than relying on the editor alone.
 *
 * Warn-only, and it rewrites nothing, same rule as warnAboutDayParts. An
 * overlap that slips through is still resolved deterministically -
 * day-parts.js's blockContextAt gives it to whichever block was declared
 * first - this only makes sure that isn't happening silently.
 */
function warnAboutBlocks(json) {
    if (typeof(json.blocks) === 'undefined') {
        return;
    }
    const complain = (message) => {
        console.error(`Channel ${json.number}: ${message}`);
    };
    if (! Array.isArray(json.blocks) ) {
        complain(`blocks was saved as ${typeof(json.blocks)} rather than an array. It will be ignored and the channel's day-parts (or Flex tab) used instead.`);
        return;
    }
    const badTime = (t) => (typeof(t) !== 'number') || isNaN(t) || (t < 0) || (t >= DAY_MS);
    // Every valid airing's occupied span this week, in week-position terms,
    // carried alongside the block it belongs to - collected first so overlap
    // can be checked pairwise afterwards, across every block at once rather
    // than one at a time.
    //
    // Computed at shift = 0 (standard time): a pair that only overlaps
    // because one of them is shiftWithDst and the season has carried it into
    // the other is a real case, but a rarer one, that this check does not
    // catch. The resolver's own tie-break is correct either way; this is a
    // diagnostic, not the safety net.
    let spans = [];
    for (let i = 0; i < json.blocks.length; i++) {
        const block = json.blocks[i];
        const label = `block ${i}` + ( (block != null) && block.name ? ` ("${block.name}")` : '' );
        if (block == null) {
            complain(`${label} is empty.`);
            continue;
        }
        if (! Array.isArray(block.airings) || (block.airings.length === 0) ) {
            complain(`${label} has no airings, so it never airs.`);
            continue;
        }
        for (let j = 0; j < block.airings.length; j++) {
            const airing = block.airings[j];
            const airingLabel = `${label} airing ${j}`;
            if (airing == null) {
                complain(`${airingLabel} is empty.`);
                continue;
            }
            if (! Array.isArray(airing.days) || (airing.days.length === 0) ) {
                complain(`${airingLabel} names no days, so it never airs.`);
                continue;
            }
            if (badTime(airing.start)) {
                complain(`${airingLabel} has start ${airing.start}, which should be a number of milliseconds from midnight between 0 and ${DAY_MS - 1}. It will be ignored.`);
                continue;
            }
            if (badTime(airing.end)) {
                complain(`${airingLabel} has end ${airing.end}, which should be a number of milliseconds from midnight between 0 and ${DAY_MS - 1}. It will be ignored.`);
                continue;
            }
            if (airing.start === airing.end) {
                complain(`${airingLabel} has the same start and end, so it never airs.`);
                continue;
            }
            let span = airing.end - airing.start;
            if (span < 0) {
                span += DAY_MS;   // crosses midnight; belongs to its start day, same as the resolver
            }
            for (const day of airing.days) {
                if ( (typeof(day) !== 'number') || ! Number.isInteger(day) || (day < 0) || (day > 6) ) {
                    complain(`${airingLabel} names day ${day}, which should be an integer from 0 (Sunday) to 6. It will be ignored.`);
                    continue;
                }
                const from = day * DAY_MS + airing.start;
                spans.push( { from: from, to: from + span, blockIndex: i, label: airingLabel } );
            }
        }
    }
    // Circular overlap: a span may already run past the end of the week (one
    // starting late Saturday and crossing into Sunday), so each pair is also
    // checked one week off in both directions - the same wraparound
    // day-parts.js's spanCovers reads at resolve time.
    const overlaps = (a, b) => (a.from < b.to) && (b.from < a.to);
    const collide = (a, b) => overlaps(a, b)
        || overlaps(a, { from: b.from - WEEK_MS, to: b.to - WEEK_MS })
        || overlaps(a, { from: b.from + WEEK_MS, to: b.to + WEEK_MS });
    for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
            const a = spans[i], b = spans[j];
            if (a.blockIndex === b.blockIndex) {
                continue;   // one block's own airings never conflict with each other
            }
            if (collide(a, b)) {
                complain(`${a.label} overlaps ${b.label}. Airings of different blocks may not overlap; whichever is declared first wins there and the other's mix never plays at that moment.`);
            }
        }
    }
}

class ChannelDB {

    constructor(folder) {
        this.folder = folder;
    }

    async getChannel(number) {
        let f = path.join(this.folder, `${number}.json` );
        for (let attempt = 0; ; attempt++) {
            try {
                return await readChannelFile(f);
            } catch (err) {
                // a channel that simply is not there must not cost the ladder
                if ( (err.code === 'ENOENT') || (attempt >= READ_RETRY_DELAYS.length) ) {
                    console.error(err);
                    return null;
                }
                if (attempt === 0) {
                    console.log(
                        `Could not read channel ${number} (${err.code || 'unparseable'});`
                        + ` it may be being written. Retrying...`
                    );
                }
                await new Promise( (resolve) => {
                    setTimeout(resolve, READ_RETRY_DELAYS[attempt]);
                } );
            }
        }
    }
    
    async saveChannel(number, json) {
        await this.validateChannelJson(number, json);
        let f = path.join(this.folder, `${json.number}.json` );
        return await new Promise( (resolve, reject) => {
            let data = undefined;
            try {
                data = JSON.stringify(json);
            } catch (err) {
                return reject(err);
            }
            fs.writeFile(f, data, (err) => {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }

    saveChannelSync(number, json) {
        this.validateChannelJson(number, json);
        
        let data = JSON.stringify(json);
        let f = path.join(this.folder, `${json.number}.json` );
        fs.writeFileSync( f, data );
    }

    validateChannelJson(number, json) {
        json.number = number;
        if (typeof(json.number) === 'undefined') {
            throw Error("Expected a channel.number");
        }
        if (typeof(json.number) === 'string') {
            try {
                json.number = parseInt(json.number);
            } catch (err) {
                console.error("Error parsing channel number.", err);
            }
        }
        if ( isNaN(json.number)) {
            throw Error("channel.number must be a integer");
        }
        warnAboutAbsoluteImages(json);
        warnAboutDayParts(json);
        warnAboutBlocks(json);
    }

    async deleteChannel(number) {
        let f = path.join(this.folder, `${number}.json` );
        await new Promise( (resolve, reject) => {
            fs.unlink(f, function (err) {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });
    }
    
    async getAllChannelNumbers() {
        return await new Promise( (resolve, reject) => {
            fs.readdir(this.folder, function(err, items) {
                if (err) {
                    return reject(err);
                }
                let channelNumbers = [];
                for (let i = 0; i < items.length; i++) {
                    let name = path.basename( items[i] );
                    if (path.extname(name) === '.json') {
                        let numberStr = name.slice(0, -5);
                        if (!isNaN(numberStr)) {
                            channelNumbers.push( parseInt(numberStr) );
                        }
                    }
                }
                // readdir returns filenames lexicographically, so 10.json sorts
                // before 2.json. Sorting here rather than in each caller keeps
                // the HDHR lineup and XMLTV guide agreeing with the M3U and API.
                channelNumbers.sort( (a, b) => a - b );
                resolve (channelNumbers);
            });
        });
    }
    
    async getAllChannels() {
        let numbers = await this.getAllChannelNumbers();
        return await Promise.all( numbers.map( async (c) => this.getChannel(c) ) );
    }
    
}










module.exports = ChannelDB;