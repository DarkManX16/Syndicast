const path = require('path');
var fs = require('fs');

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

class ChannelDB {

    constructor(folder) {
        this.folder = folder;
    }

    async getChannel(number) {
        let f = path.join(this.folder, `${number}.json` );
        try {
            return await new Promise( (resolve, reject) => {
                fs.readFile(f, (err, data) => {
                    if (err) {
                        return reject(err);
                    }
                    try {
                        resolve( JSON.parse(data) )
                    } catch (err) {
                        reject(err);
                    }
                })
            });
        } catch (err) {
            console.error(err);
            return null;
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