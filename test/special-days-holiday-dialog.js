/*
 * The Time Slots dialog's holiday plumbing (web/directives/time-slots-schedule-editor.js,
 * NOTES.md "Special days", step 8), two things found in the step 9 review:
 *   - the holiday rows' shows are read from Plex once, not again while the regular read
 *     of the same show is still under way (every holiday row's show is a regular slot too);
 *   - a channel with no holiday rows never pays for the catalog-state copy the holiday items
 *     are worked out from, on every Create Lineup and every row line.
 * The functions are lifted from the directive by name, with their collaborators stubbed.
 */
const { Suite, liftSource } = require('./support');
const specialDays = require('../src/special-days');

const FILE = 'web/directives/time-slots-schedule-editor.js';

const schedule = (rows) => ({ specialDays: [ { id: 'sd_t', holiday: 'Christmas', slots: rows } ] });
const row = (showId, extra) => Object.assign({ showId, order: 'next' }, extra || {});

module.exports = async function () {
    const suite = new Suite('special-days-holiday-dialog');

    {
        // The regular read of tv.A (a regular slot too) is under way; tv.B is only on the day.
        const catalogs = {};
        const holidayCatalogs = {};
        const reads = [];
        const catalogReader = { read: async (shows) => { reads.push(shows.map( (s) => s.showId )); return Object.fromEntries(shows.map( (s) => [ s.showId, { items: [] } ] )); } };
        const reading = new Promise( (resolve) => setTimeout( () => { catalogs['tv.A'] = { items: [] }; resolve(); }, 20 ) );
        const scope = { schedule: schedule([ row('tv.A', { holidayOnly: true }), row('tv.B', { holidayOnly: true }) ]), catalog: { unreadable: null, state: { shows: {} } } };
        const run = new Function('catalogs', 'holidayCatalogs', 'scope', 'lineupItemsOf', 'nameOf', 'catalogReader', '$timeout', 'reading', 'specialDays', 'holidayRead',
            liftSource(FILE, 'holidayShowIds') + '\n' + liftSource(FILE, 'readHoliday') + '\nreturn readHoliday;')(
            catalogs, holidayCatalogs, scope, () => [], (id) => id, catalogReader, () => {}, reading, specialDays, 0);
        await run();
        suite.check('a show the regular read is still reading is not read again for a holiday row; one only the day names is read once',
            reads.length === 1 && JSON.stringify(reads[0]) === '["tv.B"]', JSON.stringify(reads));
    }
    {
        // Nothing under way: both are read.
        const catalogs = {};
        const reads = [];
        const catalogReader = { read: async (shows) => { reads.push(shows.map( (s) => s.showId )); return {}; } };
        const scope = { schedule: schedule([ row('tv.A', { holidayOnly: true }), row('tv.B', { holidayOnly: true }) ]), catalog: { unreadable: null, state: { shows: {} } } };
        const run = new Function('catalogs', 'holidayCatalogs', 'scope', 'lineupItemsOf', 'nameOf', 'catalogReader', '$timeout', 'reading', 'specialDays', 'holidayRead',
            liftSource(FILE, 'holidayShowIds') + '\n' + liftSource(FILE, 'readHoliday') + '\nreturn readHoliday;')(
            catalogs, {}, scope, () => [], (id) => id, catalogReader, () => {}, null, specialDays, 0);
        await run();
        suite.check('...with no regular read under way, every holiday row\'s show is read, together', reads.length === 1 && JSON.stringify(reads[0]) === '["tv.A","tv.B"]', JSON.stringify(reads));
    }

    const itemsWith = (sched, spy) => new Function('specialDays', 'scope', 'catalogStateNow', 'holidayCatalogs', 'catalogs',
        liftSource(FILE, 'holidayShowIds') + '\n' + liftSource(FILE, 'holidayItemsNow') + '\nreturn holidayItemsNow;')(
        specialDays, { schedule: sched }, () => { spy.copies++; return { shows: {}, neverAir: {} }; }, {}, {});
    {
        const spy = { copies: 0 };
        const none = itemsWith(schedule([ row('tv.A'), row('tv.B', { holidayOnly: false }) ]), spy)();
        suite.check('a channel with no holiday rows is not handed the state copy, and gets no items',
            JSON.stringify(none) === '{}' && spy.copies === 0, `${spy.copies} copies`);
        const spy2 = { copies: 0 };
        itemsWith(schedule([ row('tv.A', { holidayOnly: true }) ]), spy2)();
        suite.check('...a channel with one reads it, once', spy2.copies === 1, `${spy2.copies} copies`);
    }
    return suite;
};
