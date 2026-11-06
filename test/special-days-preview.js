/*
 * Preview this day (the Time Slots dialog, NOTES.md "Special days") runs the
 * same generator Create Lineup runs, but is only ever shown: it must leave the
 * dialog's schedule as it found it. A real run clears each slot's one-time
 * startSeason once it has been used (afterRun); a preview that did so too would
 * spend the seek before the Create Lineup that was meant to make it (review,
 * Nov 5). The two functions are lifted from the directive by name, so this
 * checks the code that runs, with its collaborators stubbed.
 */
const { Suite, liftSource } = require('./support');

const FILE = 'web/directives/time-slots-schedule-editor.js';

function schedule() {
    return { slots: [ { time: 0, showId: 'tv.A', order: 'next', seasons: { startSeason: 3 } } ], specialDays: [ { id: 'sd_t', name: 'Marathon' } ] };
}

module.exports = async function () {
    const suite = new Suite('special-days-preview');

    // makeLineup with everything around it stubbed; afterRun as the directive's own does.
    const makeLineupWith = (scope) => new Function('planLineup', 'keptRows', 'scope', 'dizquetv', 'doWait', 'holidayItemsNow', 'afterRun',
        'return ' + 'async ' + liftSource(FILE, 'makeLineup'))(
        async () => ({ run: { pool: [] }, carry: null, history: [], t0: 0 }),
        { keptAhead: () => [], keptKind: () => null },
        scope,
        { calculateTimeSlots: async () => ({ programs: [], startTime: new Date(0).toISOString() }) },
        async () => {},
        () => ({}),
        (s) => { s.slots.forEach( (slot) => { delete slot.seasons.startSeason; } ); return { schedule: s }; });

    {
        const scope = { schedule: schedule() };
        const previewing = [];
        const previewDay = new Function('scope', '$timeout', 'specialDays', 'doIt',
            'return ' + 'async ' + liftSource(FILE, 'previewDay'))(
            scope, () => {},
            { problems: () => [], timetable: () => ({ rows: [], restarts: [], never: [], overrun: null }) },
            (...args) => { previewing.push(args); return makeLineupWith(scope)(...args); });
        await previewDay(scope.schedule.specialDays[0]);
        suite.check('Preview this day leaves a slot\'s one-time start season for the real Create Lineup',
            scope.schedule.slots[0].seasons.startSeason === 3 && scope.dayPreview && scope.dayPreview.error === null,
            JSON.stringify([ scope.schedule.slots[0].seasons, previewing ]));
    }
    {
        const scope = { schedule: schedule() };
        await makeLineupWith(scope)(false);
        suite.check('...while a real Create Lineup still clears it once used', typeof(scope.schedule.slots[0].seasons.startSeason) === 'undefined',
            JSON.stringify(scope.schedule.slots[0].seasons));
    }
    return suite;
};
