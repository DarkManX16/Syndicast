/*
 * Swap an airing for another episode or item, or insert one in the break
 * after it: an edit to the list itself (src/kept-rows.js). A swap changes the
 * row clicked and the Flex after it, and the episode it replaces airs at its
 * show's next airing; an insert goes in the break. Before anything is applied
 * the dialog says in one sentence what the edit does, and when the item is
 * too long for its row, offers Run late or Take the next row. Nothing is
 * re-laid. See NOTES.md, Known issues, "What you see is what airs: hand edits
 * kept in the list".
 *
 * `request`: { channel, index, mode, catalogState } from the channel page;
 * `onDone({ programs, text } | null)`.
 */
const pins = require('../../src/pins');
const keptRows = require('../../src/kept-rows');
const showCatalog = require('../../src/show-catalog');
const constants = require('../../src/constants');
const rounds = require('../../src/shuffle-rounds');
const swapRead = require('../../src/swap-read');

const SAME = 2000;

module.exports = function ($timeout, dizquetv, getShowData, commonProgramTools, catalogReader) {
    return {
        restrict: 'E',
        templateUrl: 'templates/airing-swap.html',
        replace: true,
        scope: {
            request: '=request',
            onDone: '=onDone',
        },
        link: function (scope) {
            let req = scope.request;
            let channel = req.channel;
            let schedule = channel.scheduleBackup;
            let startTime = () => new Date(channel.startTime).getTime();
            let lineupNow = () => ({ programs: channel.programs, startTime: startTime() });
            let isInsert = (req.mode === 'insert');
            scope.verb = isInsert ? 'Insert after' : 'Swap';
            // The row clicked - or, for an insert moved to another break, the row before it.
            let index = req.index;
            let rowOf = (i) => keptRows.rowsOf(lineupNow()).find( (r) => r.index === i );
            let row = rowOf(index);
            let airing = row.program;
            let around = pins.slotAround({ schedule, at: row.start });
            scope.showId = pins.swapShow({ airing, slotShow: around ? around.showId : undefined, getShowData });
            let retitle = () => {
                scope.title = isInsert
                    ? `${pins.dayClock(row.start + row.program.duration)}, in the break after ${pins.label(row.program)}` + ( (row.flex > 0) ? ` (${pins.length(row.flex)} of Flex)` : '' )
                    : `${pins.dayClock(row.start)} - ${pins.label(airing)}, ${pins.length(airing.duration)}` + ( (row.flex > 0) ? `, then ${pins.length(row.flex)} of Flex` : '' );
            };
            retitle();
            scope.state = 'pick';
            scope.filter = { text: '' };
            scope.source = 'show';
            scope.items = [];
            scope.loading = false;
            scope.error = null;

            // The shows this channel's slots play, for "Other shows on this channel".
            let names = new Map();
            commonProgramTools.slotPool(channel.programs).forEach( (p) => {
                let d = getShowData(p);
                if (d.hasShow && ! names.has(d.showId)) {
                    names.set(d.showId, d.showDisplayName);
                }
            } );
            scope.shows = [ ...new Set( schedule.slots.map( (s) => s.showId ).filter( (id) => names.has(id) ) ) ]
                .map( (id) => ({ id: id, name: names.get(id) }) ).sort( (a, b) => a.name.localeCompare(b.name) );
            scope.pick = { show: scope.showId, custom: null };
            scope.customShows = [];
            let customFromLineup = false;

            // Whether an item fits: a swap's room is the row and the Flex after it, an insert's the Flex.
            let describe = (p) => {
                let room = isInsert ? row.flex : row.program.duration + row.flex;
                let overrun = p.duration - room;
                return {
                    program: p,
                    label: pins.label(p),
                    length: pins.length(p.duration),
                    holiday: showCatalog.holidayOf(p.title),
                    fits: overrun <= constants.SLACK,
                    over: pins.length(Math.max(0, overrun)),
                };
            };
            let order = (a, b) => (getShowData(a).order - getShowData(b).order);

            // A show that can't be read still offers the episodes the lineup holds, and says why.
            let readShow = async (showId) => {
                let lineupItems = commonProgramTools.slotPool(channel.programs).filter( (p) => getShowData(p).showId === showId );
                let got = await swapRead.readShow({ read: (shows) => catalogReader.read(shows), showId: showId, title: names.get(showId), lineupItems: lineupItems });
                if (got.notice !== '') {
                    scope.error = got.notice;
                }
                return got.items;
            };
            let load = async () => {
                scope.loading = true;
                scope.error = null;
                scope.items = [];
                $timeout();
                try {
                    let list = [];
                    if (scope.source === 'holiday') {
                        // The Catalog page's holiday episodes: left out of the rotation for Ron to place by hand.
                        let state = await req.catalogState();
                        scope.items = [];
                        showCatalog.byHoliday(state).forEach( (group) => group.shows.forEach( (show) => show.entries.forEach( (e) => {
                            let showName = names.get(show.showId) || show.showId.replace(/^(tv|custom)\./, '');
                            let stub = describe({ title: e.title, duration: e.duration });
                            scope.items.push(Object.assign(stub, {
                                program: null, entry: e, holiday: group.holiday,
                                label: `${group.holiday} - ${showName}${ (typeof(e.season) === 'number') ? ' S' + String(e.season).padStart(2, '0') + 'E' + String(e.episode).padStart(2, '0') : '' } ${e.title}`,
                            }));
                        } ) ) );
                        scope.items = scope.items.filter( (r) => r.entry.duration > 0 );
                        return;
                    }
                    if (scope.source === 'custom') {
                        if ( (scope.customShows.length === 0) || customFromLineup ) {
                            let shows = await swapRead.readCustomShows({ list: () => dizquetv.getAllShowsInfo(), programs: channel.programs });
                            scope.customShows = shows.shows;
                            // Only the lineup's own list: the server is asked again next time.
                            customFromLineup = (shows.notice !== '');
                            if (shows.notice !== '') {
                                scope.error = shows.notice;
                            }
                        }
                        if (scope.pick.custom !== null) {
                            let chosen = scope.customShows.find( (s) => s.id === scope.pick.custom );
                            let got = await swapRead.readCustomItems({ get: (id) => dizquetv.getShow(id), id: scope.pick.custom,
                                name: chosen && chosen.name, programs: channel.programs });
                            list = got.items;
                            if (got.notice !== '') {
                                scope.error = got.notice;
                            }
                        }
                    } else {
                        let id = (scope.source === 'show') ? scope.showId : scope.pick.show;
                        list = (await readShow(id)).slice().sort(order);
                    }
                    scope.items = list.filter( (p) => ! p.isOffline && (p.duration > 0) ).map(describe);
                } catch (err) {
                    console.error(err);
                    scope.error = `Couldn't list the episodes. ${swapRead.explain(err)}`;
                } finally {
                    scope.loading = false;
                    $timeout();
                }
            };
            scope.setSource = (source) => {
                scope.source = source;
                load();
            };
            // One item from the Plex library, as the fallback picker does: the library's
            // own dialog on top of this one.
            scope.library = { open: false };
            scope.openLibrary = () => { scope.library.open = true; };
            scope.libraryDone = (selected) => {
                if (Array.isArray(selected) && (selected.length === 1) && (selected[0].duration > 0)) {
                    scope.choose(Object.assign(describe(selected[0]), { program: selected[0] }));
                }
                $timeout();
            };
            scope.reload = () => load();
            scope.visible = (r) => {
                let f = scope.filter.text.trim().toLowerCase();
                return (f === '') || r.label.toLowerCase().includes(f) || (r.holiday && r.holiday.toLowerCase().includes(f));
            };

            // A holiday row names its episode by file; its program comes from the show's catalog.
            let programOf = async (r) => {
                if (r.program !== null) {
                    return r.program;
                }
                let found = (await readShow(r.entry.showId)).find( (p) => rounds.fileKey(p) === r.entry.key );
                if (typeof(found) === 'undefined') {
                    throw new Error(`${r.entry.title} can't be found in its show any more - check the Catalog page.`);
                }
                r.program = found;
                return found;
            };

            /*
             * The edit, worked out on the list as it is: one choice when the item
             * fits; Run late and Take the next row when a swap's item is too long
             * (Take is refused, with its reason, when it would run into a row you
             * placed); an insert too long for its break runs late, and the breaks
             * nearby it fits whole are offered too.
             */
            scope.choose = async (r) => {
                scope.error = null;
                let p;
                try {
                    p = await programOf(r);
                } catch (err) {
                    scope.error = err.message;
                    $timeout();
                    return;
                }
                scope.chosen = r;
                let now = Date.now();
                let lineup = lineupNow();
                let option = (label, got) => ({ label: label, got: got, text: got.programs ? got.text : got.refused, refused: ! got.programs });
                scope.options = [];
                scope.breaks = [];
                if (isInsert) {
                    let got = keptRows.insertAfter({ lineup, index, item: p, now });
                    scope.options.push(option('Insert', got));
                    if (got.programs && (p.duration > row.flex + constants.SLACK)) {
                        scope.breaks = pins.breaksThatFit({ programs: channel.programs, startTime: startTime(), near: row.start + row.program.duration,
                            within: 12 * 60 * 60 * 1000, duration: p.duration, notBefore: now })
                            .filter( (b) => Math.abs(b.start - (row.start + row.program.duration)) > SAME )
                            .map( (b) => ({ text: `${pins.dayClock(b.start)}, after ${pins.label(b.after.program)} - a break of ${pins.length(b.length)}`, after: b.after.program }) );
                    }
                } else {
                    let got = keptRows.swap({ lineup, index, item: p, now, schedule });
                    if (Array.isArray(got.choices)) {
                        scope.options.push(option('Run late', keptRows.swap({ lineup, index, item: p, choice: 'late', now, schedule })));
                        scope.options.push(option('Take the next row', keptRows.swap({ lineup, index, item: p, choice: 'take', now, schedule })));
                    } else {
                        scope.options.push(option('Swap', got));
                    }
                }
                if (scope.options.every( (o) => o.refused )) {
                    scope.error = scope.options[0].text;
                    scope.options = [];
                    $timeout();
                    return;
                }
                scope.state = 'choose';
                $timeout();
            };
            // "A break where it fits": the insert goes after another program, worked out again.
            scope.putInBreak = (b) => {
                let i = channel.programs.indexOf(b.after);
                if (i === -1) {
                    return;
                }
                index = i;
                row = rowOf(index);
                retitle();
                scope.choose(scope.chosen);
            };
            scope.apply = (o) => {
                if (! o.refused) {
                    scope.onDone({ programs: o.got.programs, text: o.got.text });
                }
            };
            scope.back = () => {
                scope.state = 'pick';
                scope.options = [];
                if (index !== req.index) {
                    index = req.index;
                    row = rowOf(index);
                    retitle();
                }
            };
            scope.cancel = () => {
                scope.onDone(null);
            };
            load();
        },
    };
};
