#!/usr/bin/env node
/*
 * Takes the kept marks no edit of yours accounts for off a channel's list
 * (src/kept-rows.js clearWrong; NOTES.md, Resolved, "Thousands of rows kept in
 * time"), through the running server's channel API, as Update Channel saves.
 * Nothing in the list moves: only marks come off. Your swaps, inserts and
 * dragged rows still to air keep theirs.
 *
 *   node scripts/clear-wrong-kept.js --url http://localhost:18000 --channel 1
 *        says what it would clear, and changes nothing
 *   node scripts/clear-wrong-kept.js --url http://localhost:18000 --channel 1 --apply
 *        saves a copy of the channel as it was, then clears them
 *
 * Close that channel's editor first: an editor left open saves its own copy,
 * marks and all, on Update Channel.
 */
const fs = require('fs');
const path = require('path');
const keptRows = require('../src/kept-rows');
const pins = require('../src/pins');

function parseArgs(argv) {
    const out = { apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url') out.url = argv[++i];
        else if (a === '--channel') out.channel = parseInt(argv[++i], 10);
        else if (a === '--apply') out.apply = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (!out.url || !(out.channel > 0)) {
        throw new Error('usage: node scripts/clear-wrong-kept.js --url http://localhost:<port> --channel <number> [--apply]');
    }
    out.url = out.url.replace(/\/+$/, '');
    return out;
}

const marks = (channel) => channel.programs.filter((p) => p.kept).length;
const sig = (channel) => JSON.stringify([channel.startTime, channel.programs.length, channel.programs.map((p) => p.kept ? JSON.stringify(p.kept) : '').join()]);

(async () => {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    const get = async () => {
        const r = await fetch(`${opts.url}/api/channel/${opts.channel}`);
        if (!r.ok) {
            throw new Error(`channel ${opts.channel}: HTTP ${r.status}`);
        }
        return r.json();
    };
    const channel = await get();
    const now = Date.now();
    const startTime = new Date(channel.startTime).getTime();
    const got = keptRows.clearWrong({ programs: channel.programs, startTime, now });
    const kept = keptRows.keptAhead({ programs: got.programs, startTime, now }).filter((x) => keptRows.keepsItem(x.program));
    console.log(`Channel ${opts.channel}, ${channel.name}: ${got.cleared.toLocaleString('en-US')} of ${marks(channel).toLocaleString('en-US')} marked rows lose their marks.`);
    console.log(kept.length === 0 ? 'Nothing stays kept.' : `Still kept: ${kept.map((x) => `${x.program.isOffline ? 'Flex' : pins.label(x.program)} at ${pins.dayClock(x.at)}`).join('; ')}.`);
    if (got.cleared === 0 || !opts.apply) {
        if (got.cleared > 0) {
            console.log('Nothing changed. Run again with --apply to clear them.');
        }
        return;
    }
    const copy = path.resolve(`channel-${opts.channel}-before-clear-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(copy, JSON.stringify(channel));
    console.log(`Saved the channel as it was to ${copy}.`);
    // Saved by something else meanwhile (an editor's Update Channel): stop rather than overwrite it.
    if (sig(await get()) !== sig(channel)) {
        console.error('The channel changed while this ran; nothing saved. Run it again.');
        process.exit(1);
    }
    const r = await fetch(`${opts.url}/api/channel`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(Object.assign({}, channel, { programs: got.programs })),
    });
    if (!r.ok) {
        console.error(`Saving failed: HTTP ${r.status}`);
        process.exit(1);
    }
    const saved = await get();
    const again = keptRows.clearWrong({ programs: saved.programs, startTime: new Date(saved.startTime).getTime(), now: Date.now() });
    console.log(`Saved: ${marks(saved).toLocaleString('en-US')} marked rows left, ${again.cleared} more to clear.`);
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
