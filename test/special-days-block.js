/*
 * The block for a special day: resolveContext checks special days first, so
 * the named block covers the whole day - its mix, its transitions, its guide
 * name - ahead of every block airing and day-part, and nothing resolves
 * differently at any other moment. See NOTES.md, Known issues, "Special days".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const dayParts = require('../src/day-parts');
const transitions = require('../src/transitions');

const local = (y, mo, d, h, m) => new Date(y, mo - 1, d, h || 0, m || 0).getTime();
const FROM = local(2027, 1, 1, 6);
const TO = local(2027, 1, 2, 6);

// Channel 1, cut down: Toonami weekday afternoons, the Saturday Midnight Run,
// Cartoon Cartoon Fridays, and the day-parts around them.
function channel(days) {
    return {
        number: 1, name: 'Cartoon Cartoons Network',
        dayParts: [
            { id: 'dp_week', name: 'Powerhouse Era', fillerCollections: [], starts: [ { days: [ 1, 2, 3, 4, 5 ], time: 6 * HOUR } ] },
            { id: 'dp_swim', name: 'Adult Swim', fillerCollections: [], starts: [ { days: [ 2, 3, 4, 5 ], time: 0 } ] },
            { id: 'dp_city', name: 'CN City (Day)', fillerCollections: [], starts: [ { days: [ 6 ], time: 6 * HOUR }, { days: [ 0 ], time: 10 * HOUR } ] },
            { id: 'dp_night', name: 'CN City (Night)', fillerCollections: [], starts: [ { days: [ 6, 0 ], time: 19 * HOUR } ] },
        ],
        blocks: [
            { id: 'bl_toonami', name: 'Toonami', guideName: 'Toonami', fillerCollections: [],
                airings: [ { days: [ 1, 2, 3, 5 ], start: 15 * HOUR, end: 17 * HOUR } ] },
            { id: 'bl_midnight', name: 'Toonami Midnight Run', fillerCollections: [], airings: [ { days: [ 6 ], start: 1 * HOUR, end: 3 * HOUR } ] },
            { id: 'bl_ccf', name: 'Cartoon Cartoon Fridays', fillerCollections: [], airings: [ { days: [ 5 ], start: 17 * HOUR, end: 23 * HOUR } ] },
        ],
        scheduleBackup: { period: 7 * DAY, slots: [], specialDays: days },
    };
}
function newYears(extra) {
    return Object.assign({
        id: 'sd_ny', name: "New Year's Toonami Full Cycle", from: { date: '2027-01-01', time: 6 * HOUR }, to: { date: '2027-01-02', time: 6 * HOUR },
        blockId: 'bl_toonami', positions: 'advance', layout: 'back', slots: [ { showId: 'tv.Ronin Warriors', order: 'next' } ],
    }, extra || {});
}
const ep = (show) => ({ type: 'episode', showTitle: show, title: show, duration: 22 * MIN, key: '/' + show });
const brk = (prevAt, prevShow, nextAt, nextShow) => ({
    prev: (prevAt === null) ? null : { startTime: prevAt, program: ep(prevShow) },
    next: (nextAt === null) ? null : { startTime: nextAt, program: ep(nextShow) },
});
const nameOf = (c) => (c === null) ? 'none' : c.name;
// Two channel objects never share a context object: compare by id.
const idOf = (c) => (c === null) ? null : c.id;

module.exports = async () => {
    const suite = new Suite('special-days-block');
    const plain = channel(undefined);
    const ch = channel([ newYears() ]);
    const toonami = ch.blocks[0];

    suite.check('inside the day, Toonami - the block object itself - at 6:00am, 3:00pm, 8:00pm and Sat 2:00am',
        [ FROM, local(2027, 1, 1, 15), local(2027, 1, 1, 20), local(2027, 1, 2, 2) ].every( (t) => dayParts.resolveContext(ch, t) === toonami ),
        [ FROM, local(2027, 1, 1, 15), local(2027, 1, 1, 20), local(2027, 1, 2, 2) ].map( (t) => nameOf(dayParts.resolveContext(plain, t)) ).join(' / ') + ' without the day');
    let same = true;
    let firstOff = null;
    for (let t = local(2026, 12, 27); t < local(2027, 1, 10); t += MIN) {
        if ( (t >= FROM) && (t < TO) ) {
            continue;
        }
        if (idOf(dayParts.resolveContext(ch, t)) !== idOf(dayParts.resolveContext(plain, t))) {
            same = false;
            firstOff = firstOff || t;
        }
    }
    suite.check('...and every other minute from Sun Dec 27 to Sat Jan 9 resolves exactly as without the day', same,
        firstOff ? new Date(firstOff).toString() : '');
    suite.check('...the day\'s last minute is Toonami, the first after it CN City (Day)',
        dayParts.resolveContext(ch, TO - MIN) === toonami && nameOf(dayParts.resolveContext(ch, TO)) === 'CN City (Day)', '');
    suite.check('a day with no block leaves the overlay as it was',
        [ FROM, local(2027, 1, 1, 18), local(2027, 1, 2, 2) ].every( (t) => idOf(dayParts.resolveContext(channel([ newYears({ blockId: null }) ]), t)) === idOf(dayParts.resolveContext(plain, t)) ), '');
    suite.check('...and so does a day naming a block that is gone',
        [ FROM, local(2027, 1, 1, 18) ].every( (t) => idOf(dayParts.resolveContext(channel([ newYears({ blockId: 'bl_gone' }) ]), t)) === idOf(dayParts.resolveContext(plain, t)) ), '');
    const onDemand = Object.assign(channel([ newYears() ]), { onDemand: { isOnDemand: true } });
    suite.check('...and an on-demand channel has no overlay at all, special day or not', dayParts.resolveContext(onDemand, FROM) === null, '');

    // The breaks, as transitions classify them.
    const before = transitions.assemble(ch, brk(local(2027, 1, 1, 5, 30), 'The Batman', FROM, 'Superman'));
    suite.check('the break before the day\'s first row: a boundary, entering Toonami',
        before.situation === 'boundary' && before.to === toonami && nameOf(before.from) === 'Adult Swim', `${before.situation} ${nameOf(before.from)} -> ${nameOf(before.to)}`);
    const inside = transitions.assemble(ch, brk(local(2027, 1, 1, 7), 'Super Friends', local(2027, 1, 1, 7, 45), 'Super Friends'));
    const across3pm = transitions.assemble(ch, brk(local(2027, 1, 1, 14, 30), 'ThunderCats', local(2027, 1, 1, 15), 'SubZero'));
    const across5pm = transitions.assemble(ch, brk(local(2027, 1, 1, 16, 30), 'Sailor Moon', local(2027, 1, 1, 17, 15), 'Powerpuff'));
    const acrossMidnight = transitions.assemble(ch, brk(local(2027, 1, 2, 0, 45), 'Powerpuff', local(2027, 1, 2, 1, 15), 'Dragon Ball Z'));
    suite.check('breaks inside: Toonami\'s, never a boundary - where its own 3:00pm airing and Cartoon Cartoon Fridays\' 5:00pm would begin, and the Midnight Run\'s 1:00am',
        [ inside, across3pm, across5pm, acrossMidnight ].every( (b) => (b.situation !== 'boundary') && (b.from === toonami) && (b.to === toonami) )
            && inside.situation === 'betweenEpisodes' && across3pm.situation === 'betweenShows',
        [ inside, across3pm, across5pm, acrossMidnight ].map( (b) => b.situation ).join(', '));
    const after = transitions.assemble(ch, brk(local(2027, 1, 2, 5, 15), 'Super Friends', local(2027, 1, 2, 6, 1, 5), 'Baby Looney Tunes'));
    suite.check('the break after the day\'s last item, which began inside it: a boundary, leaving Toonami for CN City (Day)',
        after.situation === 'boundary' && after.from === toonami && nameOf(after.to) === 'CN City (Day)', `${after.situation} ${nameOf(after.from)} -> ${nameOf(after.to)}`);
    const plainInside = transitions.assemble(plain, brk(local(2027, 1, 1, 14, 30), 'ThunderCats', local(2027, 1, 1, 15), 'X-Men'));
    suite.check('...where without the day 3:00pm Friday is a boundary into Toonami from the weekday day-part',
        plainInside.situation === 'boundary' && nameOf(plainInside.from) === 'Powerhouse Era', `${plainInside.situation} ${nameOf(plainInside.from)}`);

    // The guide's name for a long Flex, and the mix that fills a break.
    suite.check('the guide: a long Flex inside the day takes Toonami\'s guide name',
        dayParts.guideNameFor(ch, dayParts.resolveBreakContext(ch, local(2027, 1, 1, 11), local(2027, 1, 1, 12))) === 'Toonami'
            && dayParts.guideNameFor(plain, dayParts.resolveBreakContext(plain, local(2027, 1, 1, 11), local(2027, 1, 1, 12))) === 'Cartoon Cartoons Network', '');

    // The Schedule tab's band.
    const week = dayParts.weeklySegments(ch, local(2026, 12, 30, 12));
    const fri = week[5].filter( (s) => s.context === toonami );
    const sat = week[6].filter( (s) => s.context === toonami );
    suite.check('the week of Dec 27: Toonami from Fri 6:00am to midnight and Sat midnight to 6:00am',
        fri.length === 1 && fri[0].startMs === 6 * HOUR && fri[0].endMs === DAY && sat.length === 1 && sat[0].startMs === 0 && sat[0].endMs === 6 * HOUR,
        JSON.stringify(week[5].map( (s) => [ nameOf(s.context), s.startMs / HOUR, s.endMs / HOUR ] )));
    const later = dayParts.weeklySegments(ch, local(2027, 1, 6, 12));
    const seg = (w) => JSON.stringify(w.map( (d) => d.map( (x) => [ idOf(x.context), x.startMs, x.endMs ] ) ));
    suite.check('...and the week after is the regular week', seg(later) === seg(dayParts.weeklySegments(plain, local(2027, 1, 6, 12))), '');
    return suite;
};
