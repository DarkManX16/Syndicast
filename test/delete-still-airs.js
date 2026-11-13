/*
 * A deleted episode never airs again on the channel, except where Ron placed
 * that very airing himself: a swap or an insert in the list, one inside a
 * special day, or a day's picked item (Ron, Nov 12, 2026). Delete's one
 * sentence names those still ahead - src/kept-rows.js handPlacedAhead and
 * stillAirs. See NOTES.md, Resolved, "Deleted episodes kept coming back".
 */
const { MIN, HOUR, DAY, Suite } = require('./support');
const kept = require('../src/kept-rows');

const START = new Date(2026, 10, 12, 6, 0).getTime();     // Thu Nov 12, 2026, 6:00am
const NOW = START + 10 * MIN;
const ep = (show, n, extra) => Object.assign({ type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n,
    duration: 22 * MIN, serverKey: 'srv', key: `/e/${show}/${n}`, slotPosition: 'next|' }, extra || {});
const brk = (ms) => ({ isOffline: true, duration: ms });
const edit = (kind, extra) => Object.assign({ id: 'e' + kind + Math.random(), kind, made: new Date(NOW).toISOString() }, extra || {});
const keptAs = (...kinds) => ({ kept: { edits: kinds.map( (k) => edit(k) ) } });

// Half hours from 6:00am: `rows` are [ program, ... ], each with 8 minutes of Flex after it.
function lineup(rows) {
    let programs = [];
    rows.forEach( (p) => { programs.push(p); programs.push(brk(30 * MIN - p.duration)); } );
    return { programs, startTime: START };
}
const X = ep('House of Mouse', 9);
const schedule = { slots: [], specialDays: [
    { id: 'sd_m', name: 'House of Mouse Marathon', slots: [ { showId: 'tv.House of Mouse', order: 'shuffle', changes: [ { id: 'ch1', n: 2, kind: 'swap', item: { program: X } } ] } ] },
    { id: 'sd_p', name: 'Movie Night', slots: [ { showId: 'tv.House of Mouse', item: { program: X } } ] },
] };

module.exports = async function () {
    const suite = new Suite('delete-still-airs');
    const at = (k) => START + k * 30 * MIN;
    // 0: on air, a swap of it (aired/airing counts as ahead only while it runs); 1: a regular airing; 2: my swap;
    // 3: another episode's swap; 4: my insert; 5: a row I only dragged; 6: inside a day, swapped in;
    // 7: inside a day, the row's own pick of the rotation; 8: inside a day, inserted; 9: a day's picked item;
    // 10: a regular row carrying a day mark left over from the pool; 11: a swap later shifted and moved.
    const rows = [
        ep('Recess', 1),
        X,
        Object.assign({}, X, keptAs('swap')),
        ep('House of Mouse', 4, keptAs('swap')),
        Object.assign({}, X, keptAs('insert')),
        Object.assign({}, X, keptAs('moved')),
        Object.assign({}, X, { specialDay: 'sd_m', specialRow: 0, specialChange: 'ch1', specialN: 2 }),
        Object.assign({}, X, { specialDay: 'sd_m', specialRow: 0, specialN: 3 }),
        Object.assign({}, X, { specialDay: 'sd_m', specialRow: 0, specialInsert: 'ch2' }),
        Object.assign({}, X, { specialDay: 'sd_p', specialRow: 0 }),
        Object.assign({}, X, { specialChange: 'ch1', specialN: 2 }),
        Object.assign({}, X, keptAs('swap', 'shifted', 'moved')),
    ];
    const l = lineup(rows);
    const found = kept.handPlacedAhead({ lineup: l, program: X, now: NOW, schedule });
    suite.check('my swaps and inserts of the episode still ahead are found - in the list and inside a day - and a day\'s picked item',
        found.map( (f) => `${(f.at - START) / (30 * MIN)}:${f.kind}` ).join() === '2:swap,4:insert,6:swap,8:insert,9:pick,11:swap',
        found.map( (f) => `${(f.at - START) / (30 * MIN)}:${f.kind}` ).join());
    suite.check('...not a regular airing, a row only dragged, a day row\'s own pick, another episode, or a leftover mark outside a day',
        ! found.some( (f) => [ at(1), at(3), at(5), at(7), at(10) ].includes(f.at) ), '');
    suite.check('...a picked item names its day', found.find( (f) => f.kind === 'pick' ).day === 'Movie Night', JSON.stringify(found.find( (f) => f.kind === 'pick' )));
    const later = kept.handPlacedAhead({ lineup: l, program: X, now: at(3), schedule });
    suite.check('one that has aired is not named', ! later.some( (f) => f.at === at(2) ) && later.some( (f) => f.at === at(4) ), '');
    suite.check('an episode nobody placed by hand: nothing', kept.handPlacedAhead({ lineup: l, program: ep('Recess', 1), now: NOW, schedule }).length === 0, '');
    const other = Object.assign({}, X, { key: '/e/House of Mouse/9-other-file' });
    suite.check('`same` decides which rows air the episode (by file unless told otherwise)',
        kept.handPlacedAhead({ lineup: l, program: other, now: NOW, schedule }).length === 0
            && kept.handPlacedAhead({ lineup: l, program: other, now: NOW, schedule, same: (p) => p.title === X.title }).length === 6, '');

    suite.log('-- what Create Lineup keeps --');
    {
        // A row Ron only dragged keeps its time, but not a deleted episode: its position's
        // next episode airs there. His swaps and inserts of it air as they are.
        const listed = (p) => p.key === X.key;
        const plainKeep = kept.keptAhead({ programs: l.programs, startTime: l.startTime, now: NOW });
        const keep = kept.keptAhead({ programs: l.programs, startTime: l.startTime, now: NOW, neverAir: listed });
        const of = (list, k) => list.find( (x) => x.at === at(k) );
        suite.check('without a never-air list, a dragged row airs as it is, as before', of(plainKeep, 5) && (typeof(of(plainKeep, 5).key) === 'undefined'), '');
        suite.check('a dragged row holding a deleted episode is kept in time only: the next episode of its position airs there',
            of(keep, 5) && (of(keep, 5).key === of(kept.keptAhead({ programs: [ Object.assign({}, X, keptAs('shifted')) ], startTime: at(5), now: NOW }), 5).key), JSON.stringify(of(keep, 5) && of(keep, 5).key));
        suite.check('...my swaps and inserts of it are kept as they are',
            [ 2, 4, 11 ].every( (k) => of(keep, k) && (typeof(of(keep, k).key) === 'undefined') && (of(keep, k).program === l.programs[2 * k]) ), '');
        suite.check('...and so is every other kept row', JSON.stringify(keep.filter( (x) => x.at !== at(5) )) === JSON.stringify(plainKeep.filter( (x) => x.at !== at(5) )), '');
        const noPosition = [ Object.assign({}, X, keptAs('moved'), { slotPosition: undefined }) ];
        suite.check('a dragged row of a deleted episode no slot made is let go: nothing to air in its place',
            kept.keptAhead({ programs: noPosition, startTime: at(5), now: NOW, neverAir: listed }).length === 0, '');
    }

    suite.log('-- the sentence --');
    const nov19 = new Date(2026, 10, 19, 14, 30).getTime();
    const nov26 = new Date(2026, 10, 26, 16, 0).getTime();
    const dec3 = new Date(2026, 11, 3, 9, 5).getTime();
    const says = (list, text) => suite.check(text, kept.stillAirs(list) === text, kept.stillAirs(list));
    suite.check('nothing placed by hand: nothing said', kept.stillAirs([]) === '', kept.stillAirs([]));
    says([ { at: nov19, kind: 'swap' } ], 'Your swap of it on Nov 19 at 2:30pm still airs; Put back that swap to remove it too.');
    says([ { at: nov19, kind: 'swap' }, { at: nov26, kind: 'swap' } ],
        'Your swaps of it on Nov 19 at 2:30pm and Nov 26 at 4:00pm still air; Put back those swaps to remove them too.');
    says([ { at: nov19, kind: 'insert' } ], 'Your insert of it on Nov 19 at 2:30pm still airs; Put back that insert to remove it too.');
    says([ { at: nov19, kind: 'swap' }, { at: nov26, kind: 'insert' } ],
        'Your swap of it on Nov 19 at 2:30pm and your insert of it on Nov 26 at 4:00pm still air; Put them back to remove them too.');
    says([ { at: nov19, kind: 'swap' }, { at: nov26, kind: 'swap' }, { at: dec3, kind: 'swap' }, { at: dec3 + DAY, kind: 'swap' }, { at: dec3 + 2 * DAY, kind: 'swap' } ],
        'Your swaps of it on Nov 19 at 2:30pm, Nov 26 at 4:00pm, Dec 3 at 9:05am and 2 more still air; Put back those swaps to remove them too.');
    says([ { at: nov26, kind: 'pick', day: 'Movie Night' } ],
        'Your pick of it for Movie Night on Nov 26 at 4:00pm still airs; remove its row in Time Slots to remove it too.');
    says([ { at: nov19, kind: 'swap' }, { at: nov26, kind: 'pick', day: 'Movie Night' } ],
        'Your swap of it on Nov 19 at 2:30pm and your pick of it for Movie Night on Nov 26 at 4:00pm still air; Put back the swap, and remove the pick\'s row in Time Slots, to remove them too.');
    suite.check('one short line, whatever is ahead', kept.stillAirs(found).length < 260, `${kept.stillAirs(found).length} characters: ${kept.stillAirs(found)}`);
    return suite;
};
