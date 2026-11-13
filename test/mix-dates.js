/*
 * Dates on a Mix entry (NOTES.md, "Event tools"): an entry with
 * `dates: { from, to }` is in its mix only for breaks that start on those
 * dates, both ends included; outside them the other entries share its
 * weight. A mix with no dated entry is handed to the picker as the very
 * array it always was. DarkManX16's case: "MAAM Promos" in the Bounce Era
 * day-parts' Mix, Nov 15-26, 2026.
 */
const { helperFuncs, dayParts, MIN, HOUR, at, freshStore, clip, show, flex, mix, Suite } = require('./support');
const ChannelDB = require('../src/dao/channel-db');

const LISTS = {
    Bounce: [clip('Bounce#1', 2), clip('Bounce#2', 2), clip('Bounce#3', 2)],
    MAAM: [clip('MAAM#1', 2), clip('MAAM#2', 2)],
};
const ownerOf = (title) => title.split('#')[0];
const MAAM_DATES = { from: '2026-11-15', to: '2026-11-26' };

function withDates(entries, dates) {
    return entries.map( (e) => (e.id === 'MAAM') ? Object.assign({}, e, { dates: dates }) : e );
}
function dayPartChannel(dates) {
    return {
        number: 91, name: 'Bounce', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: mix([['Bounce', 100]]),
        dayParts: [
            { name: 'Bounce Era', fillerCollections: withDates(mix([['Bounce', 300], ['MAAM', 75]]), dates),
              starts: [{ days: [0, 1, 2, 3, 4, 5, 6], time: 0 }] },
        ],
    };
}
function plainChannel(dates) {
    return {
        number: 92, name: 'Plain', offlineMode: 'pic', fallback: [], fillerRepeatCooldown: 0,
        fillerCollections: withDates(mix([['Bounce', 300], ['MAAM', 75]]), dates),
    };
}
function fillersFor(channel) {
    return dayParts.allFillerCollections(channel).map( (c) => ({
        id: c.id, content: LISTS[c.id] || [], weight: c.weight, cooldown: c.cooldown,
    }) );
}

// Picks for a break that starts at `breakStart` and lasts 8 minutes, drawn
// `elapsedMins` into it - [show, flex, show], programIndex 1.
function draw(channel, breakStart, elapsedMins) {
    const programs = [show('Before', 30), flex(8), show('After', 30)];
    const c = Object.assign({}, channel, { programs });
    const obj = { program: programs[1], timeElapsed: (elapsedMins || 3) * MIN, programIndex: 1 };
    const t0 = breakStart + obj.timeElapsed;
    const fillers = fillersFor(c);
    const tally = {};
    const store = freshStore();
    for (let i = 0; i < 300; i++) {
        const item = helperFuncs.createLineup(store, obj, c, fillers, false, t0).shift();
        const key = (item.type === 'commercial') ? ownerOf(item.title) : `<${item.type}>`;
        tally[key] = (tally[key] || 0) + 1;
    }
    return tally;
}

module.exports = async function run() {
    const suite = new Suite('mix-dates');

    for (const [label, make] of [ ['a day-part\'s mix', dayPartChannel], ['the Flex tab\'s mix', plainChannel] ]) {
        const ch = make(MAAM_DATES);
        const nov14 = draw(ch, at('2026-11-14T20:00:00'));
        const nov15 = draw(ch, at('2026-11-15T00:00:00'));
        const nov26 = draw(ch, at('2026-11-26T20:00:00'));
        const nov27 = draw(ch, at('2026-11-27T00:00:00'));
        suite.check(`${label}: before its dates a dated entry is never picked`, ! nov14.MAAM && nov14.Bounce === 300, JSON.stringify(nov14));
        suite.check(`${label}: on its first date it is picked`, nov15.MAAM > 0, JSON.stringify(nov15));
        suite.check(`${label}: on its last date it is picked`, nov26.MAAM > 0, JSON.stringify(nov26));
        suite.check(`${label}: the day after, it stops by itself`, ! nov27.MAAM && nov27.Bounce === 300, JSON.stringify(nov27));
        const lateBreak = draw(ch, at('2026-11-26T23:56:00'), 6);
        suite.check(`${label}: a break starting 11:56pm on Nov 26 is a Nov 26 break, though drawn after midnight`,
            lateBreak.MAAM > 0, JSON.stringify(lateBreak));
        const bad = draw(make({ from: '2026-11-26', to: '2026-11-15' }), at('2026-11-20T20:00:00'));
        suite.check(`${label}: an entry whose dates end before they start is never picked`, ! bad.MAAM, JSON.stringify(bad));
        const none = draw(make(undefined), at('2026-11-14T20:00:00'));
        suite.check(`${label}: an undated entry is picked on any date, as before`, none.MAAM > 0, JSON.stringify(none));
    }

    // A mix with no dated entry is the very array it was.
    const plainMix = mix([['Bounce', 300], ['MAAM', 75]]);
    suite.check('a mix with no dated entry comes back as the same array',
        dayParts.mixOn(plainMix, at('2026-11-20T20:00:00')) === plainMix);
    const nullDates = plainMix.map( (e) => Object.assign({}, e, { dates: null }) );
    suite.check('dates: null is undated too', dayParts.mixOn(nullDates, at('2026-11-20T20:00:00')) === nullDates);
    const dated = withDates(plainMix, MAAM_DATES);
    suite.check('a dated mix outside the dates keeps only the others, in order',
        JSON.stringify(dayParts.mixOn(dated, at('2026-12-01T20:00:00')).map( (e) => e.id )) === '["Bounce"]');
    suite.check('and inside them keeps every entry', dayParts.mixOn(dated, at('2026-11-20T20:00:00')).length === 2);
    const plain = plainChannel(undefined);
    const fillers = fillersFor(plain);
    suite.check('a Flex-tab mix with no dated entry hands back the same fillers array',
        dayParts.channelMixOn(plain, fillers, at('2026-11-20T20:00:00')) === fillers);

    // The editor: the row's words, greyed once the dates have passed, and
    // "Convert to day-parts" carrying an entry's dates with it.
    {
        const dateRange = require('../src/date-range');
        const editor = require('../src/transitions-editor');
        suite.check('a Mix row shows its dates as the chip does', editor.datesChipWord({ dates: MAAM_DATES }) === 'Nov 15–26'
            && editor.datesChipWord({}) === null);
        suite.check('dates have not passed on their last date',
            dateRange.passed(MAAM_DATES, at('2026-11-26T23:59:00')) === false);
        suite.check('dates have passed the day after', dateRange.passed(MAAM_DATES, at('2026-11-27T00:00:00')) === true);
        suite.check('no dates never pass', dateRange.passed(null, at('2030-01-01T00:00:00')) === false);
        const copied = dayParts.copyMixEntry({ id: 'MAAM', weight: 75, cooldownMinutes: 30, cooldown: 0, dates: MAAM_DATES,
            percentage: '20%', options: [] });
        suite.check('converting the Flex tab to day-parts keeps the dates of an entry, and its cooldown in ms',
            JSON.stringify(copied) === JSON.stringify({ id: 'MAAM', weight: 75, cooldown: 30 * MIN, dates: MAAM_DATES }), JSON.stringify(copied));
        const undated = dayParts.copyMixEntry({ id: 'Bounce', weight: 300, cooldown: 60000 });
        suite.check('... and an undated entry copies exactly as before',
            JSON.stringify(undated) === JSON.stringify({ id: 'Bounce', weight: 300, cooldown: 60000 }), JSON.stringify(undated));
    }

    // The channel page's "in a break" mix lists what is really in play.
    {
        const status = require('../src/services/channel-status-service');
        const fillerDB = { getFiller: async (id) => ({ name: id, content: LISTS[id] || [] }) };
        const onAir = (channel, breakStart) => Object.assign({}, channel, {
            programs: [show('Before', 30), flex(8), show('After', 30)],
            startTime: new Date(breakStart - 30 * MIN).toISOString(), duration: 68 * MIN,
        });
        for (const [label, make] of [ ['a day-part', dayPartChannel], ['the Flex tab', plainChannel] ]) {
            const after = await status.getNowPlaying(onAir(make(MAAM_DATES), at('2026-11-27T20:00:00')), fillerDB, at('2026-11-27T20:03:00'));
            const during = await status.getNowPlaying(onAir(make(MAAM_DATES), at('2026-11-20T20:00:00')), fillerDB, at('2026-11-20T20:03:00'));
            suite.check(`the channel page shows ${label}'s break mix without a list whose dates have passed`,
                after.state === 'break' && JSON.stringify(after.mix.map( (m) => m.id )) === '["Bounce"]', JSON.stringify(after.mix));
            suite.check(`... and with it on its dates`,
                during.state === 'break' && JSON.stringify(during.mix.map( (m) => m.id )) === '["Bounce","MAAM"]', JSON.stringify(during.mix));
        }
    }

    // Save-time warnings, for every mix a channel holds.
    {
        const db = new ChannelDB('unused');
        const warnings = (channel) => {
            const lines = [];
            const real = console.error;
            console.error = (...args) => lines.push(args.join(' '));
            try {
                db.validateChannelJson(7, channel);
            } finally {
                console.error = real;
            }
            return lines.filter( (l) => /dates/.test(l) );
        };
        suite.check('good dates on a mix entry are not warned about',
            warnings(dayPartChannel(MAAM_DATES)).length === 0 && warnings(plainChannel(MAAM_DATES)).length === 0);
        const backwards = { from: '2026-11-26', to: '2026-11-15' };
        suite.check('backwards dates on a day-part\'s mix entry are warned about', warnings(dayPartChannel(backwards)).length === 1);
        suite.check('backwards dates on the Flex tab\'s mix entry are warned about', warnings(plainChannel(backwards)).length === 1);
        const block = Object.assign(plainChannel(undefined), { blocks: [ { id: 'b1', name: 'Blk', airings: [],
            fillerCollections: withDates(mix([['Bounce', 300], ['MAAM', 75]]), { from: 'Nov 15' }) } ] });
        suite.check('malformed dates on a block\'s mix entry are warned about', warnings(block).length === 1);
    }
    return suite;
};
