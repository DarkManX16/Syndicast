/*
 * The channel page's silent first open (Ron, Oct 30): no dialog, no "Not
 * now"/"Keep them" choice, no message. The first time a channel whose list
 * still holds pins from before kept rows is edited or Create Lineup runs,
 * web/directives/channel-config.js's ensureHandEditsKept keeps every real
 * swap, insert and dragged row still to air and lets everything else go -
 * exactly what src/kept-rows.js's firstOpen/applyFirstOpen decide, which it
 * used to ask about and now just does. Lifted from the source by brace-
 * matching, the same way test/kept-editor.js does, since the page itself
 * needs a browser.
 *
 * What counts as "still to air" - including the lineup's-end guard against
 * the old "Keep them" bug that once marked 19,073 rows on channel 1 - is
 * proved pure in test/kept-rows.js. This file proves the editor only ever
 * reaches that guarded code, never a shortcut of its own, and never leaves
 * the decision sitting unanswered for a human to get wrong.
 */
const fs = require('fs');
const path = require('path');
const { Suite, MIN, HOUR, DAY } = require('./support');
const keptRows = require('../src/kept-rows');
const getShowData = require('../web/services/get-show-data')();

const SEC = 1000;
const SRC = fs.readFileSync(path.join(__dirname, '../web/directives/channel-config.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../web/public/templates/channel-config.html'), 'utf8');

// Same lift-by-brace-matching as test/kept-editor.js.
function liftArrow(src, name, owner = 'let ') {
    const head = `${owner}${name} = `;
    const at = src.indexOf(head);
    if (at === -1) {
        throw new Error(`channel-config.js no longer declares ${name}`);
    }
    let i = src.indexOf('{', at);
    for (let depth = 0; i < src.length; i++) {
        if (src[i] === '{') {
            depth++;
        } else if ( (src[i] === '}') && (--depth === 0) ) {
            break;
        }
    }
    return src.slice(at + head.length, i + 1);
}

// ensureHandEditsKept and its sibling firstOpenFound, lifted together into one
// closure around a stand-in scope - the real code never calls keptRows or
// getShowData through scope, so they're free variables of the lift itself.
function liftEnsure() {
    const body = 'let firstOpenAnswered = false;\n'
        + `let firstOpenFound = ${liftArrow(SRC, 'firstOpenFound')};\n`
        + `let ensureHandEditsKept = ${liftArrow(SRC, 'ensureHandEditsKept')};\n`
        + 'return ensureHandEditsKept;';
    // eslint-disable-next-line no-new-func
    return new Function('scope', 'keptRows', 'getShowData', 'lineupMs', 'updateChannelDuration', body);
}

function makeScope({ programs, startTime, schedule, handEditsKept }) {
    const scope = { hasTimeSlots: () => true, channel: { programs, startTime, scheduleBackup: schedule, handEditsKept } };
    const lineupMs = () => ({ programs: scope.channel.programs, startTime: scope.channel.startTime });
    const ensure = liftEnsure()(scope, keptRows, getShowData, lineupMs, () => {});
    return { scope, ensure };
}

// As src/kept-rows.js's own test fixture (test/kept-rows.js): six weeks of a
// weekly Friday-night schedule, channel 1's real shape. Duplicated here
// rather than shared, since the two files prove different things with it -
// the generator's own tests document that choice (NOTES.md's testing style).
const THU = new Date('2026-10-29T00:00:00').getTime();
const NOW = new Date('2026-10-29T05:05:00').getTime();
const fri = (h, m) => new Date(`2026-10-30T${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`).getTime();
const NIGHT = [
    [ 0, 'Futurama' ], [ 30, 'Family Guy' ], [ 60, 'Robot Chicken', 2 ], [ 90, 'Aqua Teen Hunger Force' ],
    [ 120, 'Space Ghost Coast to Coast' ], [ 150, 'Sealab 2021' ], [ 180, 'Home Movies' ], [ 210, 'The Venture Bros.' ],
    [ 240, 'Harvey Birdman, Attorney at Law' ], [ 270, 'Waynehead' ],
];
const WEEKS = 6;
function schedule() {
    return { period: 7 * DAY, lateness: DAY, pad: 5 * MIN, slots: NIGHT.map( ([ m, show ]) => ({ time: DAY + m * MIN, showId: 'tv.' + show, order: 'next' }) ) };
}
function episode(show, n, duration, extra) {
    return Object.assign({ type: 'episode', showTitle: show, title: `${show} ${n}`, season: 1, episode: n,
        duration: duration, serverKey: 'srv', key: `/e/${show}/${n}`, slotPosition: 'next|' }, extra || {});
}
const flex = (d) => ({ duration: d, isOffline: true });
function lineup() {
    let programs = [];
    let count = {};
    let next = (show, d) => { count[show] = (count[show] || 0) + 1; return episode(show, count[show], d); };
    let t = THU;
    let end = THU + WEEKS * 7 * DAY;
    let add = (p) => { programs.push(p); t += p.duration; };
    while (t < end) {
        let local = new Date(t);
        let weekday = local.getDay();
        let minutes = local.getHours() * 60 + local.getMinutes();
        let slot = (weekday === 5) ? NIGHT.find( ([ m ], i) => (m <= minutes) && ( (i === NIGHT.length - 1) || (NIGHT[i + 1][0] > minutes) ) ) : null;
        let show = (slot === null || typeof(slot) === 'undefined') ? 'Waynehead' : slot[1];
        if ( (show !== 'Waynehead') && (slot[2] === 2) ) {
            add(next(show, 11 * MIN + 35 * SEC)); add(flex(3 * MIN + 25 * SEC));
            add(next(show, 11 * MIN + 35 * SEC)); add(flex(3 * MIN + 25 * SEC));
        } else {
            add(next(show, 22 * MIN + 30 * SEC)); add(flex(7 * MIN + 30 * SEC));
        }
    }
    return { programs, startTime: THU };
}
function starts(l) {
    let out = [];
    l.programs.reduce( (t, p) => { out.push(t); return t + p.duration; }, l.startTime );
    return out;
}
const indexAt = (l, t) => starts(l).findIndex( (s, i) => (s === t) && ! l.programs[i].isOffline );
function withPin(l, at, special, extra) {
    let i = indexAt(l, at);
    let programs = l.programs.slice();
    let was = programs[i];
    programs[i] = Object.assign(episode('The Venture Bros.', 0, special.duration, { title: special.title, season: 0, episode: 4 }), {
        pin: Object.assign({ at: at, kind: 'swap', then: 'take', was: `The Venture Bros. S01E${String(was.episode).padStart(2, '0')} ${was.title}`,
            slotShow: 'tv.The Venture Bros.', made: '2026-10-29T05:28:00.000Z' }, extra || {}),
    });
    delete programs[i].slotPosition;
    if (special.duration !== was.duration) {
        programs[i + 1] = flex(was.duration + programs[i + 1].duration - special.duration);
    }
    return { programs, startTime: l.startTime };
}

module.exports = async function () {
    const suite = new Suite('first-open-silent');

    suite.log('-- the dialog is gone --');
    {
        suite.check('channel-config.js never asks: no first-open prompt state, no Not-now/Keep-them handler',
            ! /askFirstOpen|firstOpenPrompt|finishFirstOpen/.test(SRC));
        suite.check('the first-open modal is gone from the template',
            ! /firstOpenPrompt|finishFirstOpen|Keep them/.test(HTML));
        suite.check('ensureHandEditsKept still exists to apply it silently',
            SRC.includes('let ensureHandEditsKept = '));
    }

    suite.log('-- applied silently, the first time a channel is touched --');
    {
        const now = Date.now();
        const sched = { period: DAY, lateness: DAY, pad: 5 * MIN, slots: [ { time: 0, showId: 'tv.Show', order: 'next' } ] };
        const programs = [
            Object.assign(episode('Show', 1, 20 * MIN), { pin: { at: now - MIN, kind: 'swap', then: 'take', was: 'Old 1', slotShow: 'tv.Show' } }),
            flex(10 * MIN),
            episode('Show', 2, 20 * MIN),
            flex(10 * MIN),
        ];
        delete programs[0].slotPosition;
        const { scope, ensure } = makeScope({ programs, startTime: now - 5 * MIN, schedule: sched });

        ensure();
        suite.check('a real swap still to air is kept, with nothing asked and nothing said',
            keptRows.keepsItem(scope.channel.programs[0]) && (typeof(scope.lastChange) === 'undefined'),
            JSON.stringify(scope.channel.programs[0].kept));
        suite.check('Update Channel can save it: handEditsKept is set',
            typeof(scope.channel.handEditsKept) === 'string');
        suite.check('no dialog is ever shown: nothing of the kind is left on the scope',
            typeof(scope.firstOpenPrompt) === 'undefined');

        const after = scope.channel.programs;
        ensure();
        suite.check('answered once: a second call on the same channel does nothing further',
            scope.channel.programs === after);
    }

    suite.log('-- a channel with nothing to keep or let go is left alone --');
    {
        const sched = { period: DAY, lateness: DAY, pad: 5 * MIN, slots: [ { time: 0, showId: 'tv.Show', order: 'next' } ] };
        const programs = [ episode('Show', 1, 20 * MIN), flex(10 * MIN) ];
        const { scope, ensure } = makeScope({ programs, startTime: Date.now() - 5 * MIN, schedule: sched });
        ensure();
        suite.check('untouched: no handEditsKept stamp for a list that never needed one',
            typeof(scope.channel.handEditsKept) === 'undefined');
        suite.check('untouched: the programs array itself is the same one', scope.channel.programs === programs);
    }

    suite.log('-- never marks what has aired, however stale its old pinned time (the old "Keep them" bug) --');
    {
        // Channel 1, Oct 30 at 2:26am (test/kept-rows.js): A Very Venture
        // Halloween, pinned to Fri 3:30am and dragged to 12:00am, had aired by
        // then, and Create Lineup's carry had rotated it past the lineup's end
        // Flex. Its pinned time was still ahead, so the old dialog read it as a
        // pin still to air and kept 19,068 airings between its pinned time and
        // the list's end. Same shape here, run through the editor's own silent
        // apply rather than through firstOpen directly.
        const base = lineup();
        const sched = schedule();
        const tail = { programs: base.programs.concat([ flex(2 * DAY) ]), startTime: base.startTime };
        const special = withPin(tail, fri(3, 30), { title: 'A Very Venture Halloween', duration: 22 * MIN + 30 * SEC });
        const k = indexAt(special, fri(3, 30));
        const rotated = special.programs.slice();
        const row = rotated.splice(k, 1)[0];
        rotated.splice(k, 0, flex(row.duration));
        rotated.push(row, flex(7 * MIN + 30 * SEC));

        const { scope, ensure } = makeScope({ programs: rotated, startTime: base.startTime, schedule: sched });
        const originalLength = scope.channel.programs.length;
        ensure();
        const keptCount = scope.channel.programs.filter( (p) => keptRows.keepsItem(p) ).length;
        suite.check('a pin past the lineup\'s end is let go, not kept, however far ahead its stale pinned time reads',
            keptCount === 0, `${keptCount} rows kept`);
        suite.check('nothing moved: the list is still the same length', scope.channel.programs.length === originalLength);
    }

    return suite;
};
