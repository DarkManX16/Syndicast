/*
 * Swap an airing for another episode or item, pinned to its date and time
 * (src/pins.js). Picking an item re-lays the lineup through the Time Slots
 * editor's relay - twice when it runs into the next slot, once each way - and
 * says in plain words what each choice does; choosing one hands that re-lay
 * to the channel page, which applies it as Create Lineup's result. See
 * NOTES.md, Known issues, "Swaps, inserts and Flex that keeps time".
 *
 * `request`: { channel, index, mode, relay, catalogState } from the channel
 * page; `onDone(result | null)`.
 */
const pins = require('../../src/pins');
const showCatalog = require('../../src/show-catalog');
const constants = require('../../src/constants');
const rounds = require('../../src/shuffle-rounds');

const SAME = 2000;
const YEAR = 400 * 24 * 60 * 60 * 1000;

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
            let lineupNow = () => ({ programs: channel.programs, startTime: channel.startTime });
            let entry = pins.airingAt({ programs: channel.programs, startTime: startTime(), at: channel.programs[req.index].start.valueOf() });
            let airing = channel.programs[req.index];
            let around = pins.slotAround({ schedule, at: entry.start });
            let isInsert = (req.mode === 'insert');
            scope.verb = isInsert ? 'Insert after' : 'Swap';
            // A swap sits at its slot's start when the airing is that close to it; an
            // insert at the end of the airing, in the break after it.
            let at = isInsert ? entry.start + airing.duration
                : ( ( (around !== null) && (Math.abs(entry.start - around.start) <= constants.SLACK) ) ? around.start : entry.start );
            let flexAfter = pins.walk(channel.programs, startTime(), entry.start, entry.start + 1)[0].flex;
            // The slot's show the pin is made in: the airing's, or where a break was moved to.
            let slotShowAt = (instant) => { let s = pins.slotAround({ schedule, at: instant }); return s ? s.showId : getShowData(airing).showId; };
            scope.showId = around ? around.showId : getShowData(airing).showId;
            let retitle = () => {
                scope.title = isInsert
                    ? `${pins.dayClock(at)}, in the break after ${pins.label(scope.afterProgram)}` + ( (scope.breakLength > 0) ? ` (${pins.length(scope.breakLength)} of Flex)` : '' )
                    : `${pins.dayClock(at)} - ${pins.label(airing)}, ${pins.length(airing.duration)}` + ( (flexAfter > 0) ? `, then ${pins.length(flexAfter)} of Flex` : '' );
            };
            // The start of the program an insert follows - moved with it to another break.
            let afterStart = entry.start;
            scope.afterProgram = airing;
            scope.breakLength = flexAfter;
            retitle();
            scope.state = 'pick';
            scope.filter = { text: '' };
            scope.source = 'show';
            scope.items = [];
            scope.loading = false;
            scope.error = null;

            // Swapping a pinned airing replaces its pin; inserting after one keeps it.
            let ahead = () => pins.pinsAhead({ programs: channel.programs, startTime: startTime(), now: Date.now() })
                .filter( (x) => isInsert || (x.program !== airing) );

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

            let describe = (p) => {
                let fit = pins.fitAt({ programs: channel.programs, startTime: startTime(), schedule, at, duration: p.duration });
                return {
                    program: p,
                    label: pins.label(p),
                    length: pins.length(p.duration),
                    holiday: showCatalog.holidayOf(p.title),
                    fits: fit.overrun <= constants.SLACK,
                    over: pins.length(fit.overrun),
                };
            };
            let order = (a, b) => (getShowData(a).order - getShowData(b).order);

            let readShow = async (showId) => {
                let lineupItems = commonProgramTools.slotPool(channel.programs).filter( (p) => getShowData(p).showId === showId );
                let read = await catalogReader.read([ { showId: showId, title: names.get(showId), lineupItems: lineupItems } ]);
                let got = read[showId];
                if (! got || got.error || ! Array.isArray(got.items)) {
                    // Plex unreachable: the lineup's own episodes, as Create Lineup falls back.
                    scope.error = `Couldn't read ${names.get(showId) || showId} from Plex (${got && got.error ? got.error : 'no answer'}); showing the episodes already in the lineup.`;
                    return lineupItems;
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
                                label: `${group.holiday} - ${showName} S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')} ${e.title}`,
                            }));
                        } ) ) );
                        scope.items = scope.items.filter( (r) => r.entry.duration > 0 );
                        return;
                    }
                    if (scope.source === 'custom') {
                        if (scope.customShows.length === 0) {
                            scope.customShows = (await dizquetv.getAllShowsInfo()).slice().sort( (a, b) => a.name.localeCompare(b.name) );
                        }
                        if (scope.pick.custom !== null) {
                            let show = await dizquetv.getShow(scope.pick.custom);
                            list = showCatalog.fromCustom(Object.assign({ id: scope.pick.custom }, show));
                        }
                    } else {
                        let id = (scope.source === 'show') ? scope.showId : scope.pick.show;
                        list = (await readShow(id)).slice().sort(order);
                    }
                    scope.items = list.filter( (p) => ! p.isOffline && (p.duration > 0) ).map(describe);
                } catch (err) {
                    console.error(err);
                    scope.error = 'Something went wrong reading that show.';
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
            scope.visible = (row) => {
                let f = scope.filter.text.trim().toLowerCase();
                return (f === '') || row.label.toLowerCase().includes(f) || (row.holiday && row.holiday.toLowerCase().includes(f));
            };

            // Every re-lay of this dialog is planned as of the moment it opened (see relay).
            let relayNow = Date.now();
            let relayPins = async (keep) => {
                let t0 = Date.now();
                let result = await req.relay({
                    programs: commonProgramTools.slotPool(channel.programs), limit: req.limit,
                    backup: schedule, lineup: lineupNow, catalogState: await req.catalogState(), pins: keep, now: relayNow,
                });
                console.log(`Swap: re-laid the lineup in ${Date.now() - t0} ms`);
                return { result, after: { programs: result.programs, startTime: new Date(result.startTime).getTime() } };
            };
            /*
             * A re-lay changes things no pin causes: what's on air re-airs at
             * its show's next slot (stored progress's rule), and a lineup made
             * before rounds starts rounds of its own when its carried ones end.
             * So the swap's own effects are the re-lay with it against the
             * same re-lay without it (made once, as the dialog opens), and the
             * rest is said apart.
             */
            let baseline = null;
            let baselineOf = () => {
                if (baseline === null) {
                    baseline = relayPins(ahead()).then( (base) => {
                        let now = relayNow;
                        let anyway = pins.relayEffects({ before: { programs: channel.programs, startTime: startTime() }, after: base.after,
                            from: now, to: now + YEAR, schedule, getShowData });
                        base.anyway = ( (anyway.movedAlong.length + anyway.late.length + anyway.early.length) > 0 )
                            ? 'Re-making the lineup now also changes, with or without this swap: ' + pins.sayEffects(anyway) : '';
                        base.dropped = anyway.dropped;
                        return base;
                    } );
                    baseline.catch( () => { baseline = null; } );
                }
                return baseline;
            };
            let relayWith = async (pin) => {
                let base = await baselineOf();
                let mine = await relayPins(pins.withPin(ahead(), pin));
                let now = relayNow;
                let own = pins.relayEffects({ before: base.after, after: mine.after, from: Math.max(now, at - SAME), to: now + YEAR, schedule, getShowData });
                return { result: mine.result, after: mine.after, effects: pins.sayEffects(own), onAir: base.anyway, dropped: base.dropped };
            };

            // A holiday row names its episode by file; its program comes from the show's catalog.
            let programOf = async (row) => {
                if (row.program !== null) {
                    return row.program;
                }
                let found = (await readShow(row.entry.showId)).find( (p) => rounds.fileKey(p) === row.entry.key );
                if (typeof(found) === 'undefined') {
                    throw new Error(`${row.entry.title} can't be found in its show any more - check the Catalog page.`);
                }
                row.program = found;
                return found;
            };

            scope.choose = async (row) => {
                scope.state = 'working';
                scope.error = null;
                $timeout();
                let p;
                try {
                    p = await programOf(row);
                } catch (err) {
                    scope.error = err.message;
                    scope.state = 'pick';
                    $timeout();
                    return;
                }
                let clash = ahead().find( (x) => (x.at < at + p.duration) && (at < x.at + x.program.duration) );
                if (clash) {
                    scope.error = `That would run into your swap at ${pins.dayClock(clash.at)} (${clash.program.title}). Undo that one first, or pick something shorter.`;
                    scope.state = 'pick';
                    $timeout();
                    return;
                }
                scope.chosen = row;
                try {
                    let make = (then) => pins.makePin({ program: p, at, kind: isInsert ? 'insert' : 'swap', then,
                        was: isInsert ? undefined : pins.label(airing), slotShow: slotShowAt(isInsert ? afterStart : at), now: Date.now() });
                    let take = await relayWith(make('take'));
                    if (! pins.placedIn(take.after, at)) {
                        // The generator leaves out a pin it can't place: never apply a re-lay without it.
                        scope.error = `The lineup can't hold ${p.title} at ${pins.dayClock(at)}: it is past the end of what Create Lineup makes (${schedule.maxDays} days), or the lineup is full. Nothing was changed.`;
                        scope.state = 'pick';
                        return;
                    }
                    let fit = pins.fitAt({ programs: channel.programs, startTime: startTime(), schedule, at, duration: p.duration });
                    scope.fitText = pins.sayFit({ programs: channel.programs, startTime: startTime(), schedule, at, item: p, kind: isInsert ? 'insert' : 'swap', after: take.after });
                    scope.options = [];
                    scope.breaks = [];
                    if (fit.overrun <= constants.SLACK) {
                        scope.options.push(Object.assign({ label: isInsert ? 'Insert' : 'Swap' }, take));
                    } else {
                        let late = await relayWith(make('late'));
                        let into = fit.runsInto ? ` ${pins.clock(fit.slotEnd)} slot` : ' next slot';
                        let takeOver = Object.assign({ label: `Take over the${into}` }, take);
                        let runLate = pins.placedIn(late.after, at) ? Object.assign({ label: 'Run late' }, late) : null;
                        // An insert's first choice is to run late: it is the shortest way to
                        // keep what follows; a swap's is to take the slot over.
                        let ordered = isInsert ? [ runLate, takeOver ] : [ takeOver, runLate ];
                        ordered.forEach( (o) => { if (o !== null) { scope.options.push(o); } } );
                        if (isInsert) {
                            scope.breaks = pins.breaksThatFit({ programs: channel.programs, startTime: startTime(), near: at, within: 12 * 60 * 60 * 1000, duration: p.duration })
                                .filter( (b) => Math.abs(b.start - at) > SAME )
                                .map( (b) => ({ start: b.start, text: `${pins.dayClock(b.start)}, after ${pins.label(b.after.program)} - a break of ${pins.length(b.length)}`, after: b.after.program, length: b.length }) );
                        }
                    }
                    let dropped = scope.options[0].dropped;
                    let firstSwap = ahead().length === 0 && ! channel.programs.some( (x) => x.pin );
                    scope.warning = (firstSwap || dropped.length > 0)
                        ? (firstSwap ? pins.sayFirstSwap({ dropped }) : pins.sayDropped(dropped)) : '';
                    scope.error = null;
                    scope.state = 'choose';
                } catch (err) {
                    console.error(err);
                    scope.error = (err && err.serverStale) ? err.message : (err && err.message === 'busy') ? 'Another swap or undo is still being worked out - try again in a moment.' : 'The lineup could not be re-made: ' + ( (err && (err.data || err.message)) || err );
                    scope.state = 'pick';
                } finally {
                    $timeout();
                }
            };
            // "A break where it fits": the insert moves to that break and is worked out again.
            scope.putInBreak = (b) => {
                at = b.start;
                afterStart = b.after.start;
                scope.afterProgram = b.after;
                scope.breakLength = b.length;
                retitle();
                // The dialog's own re-lays are planned from the lineup as it is; only the pin moves.
                return scope.choose(scope.chosen);
            };
            scope.apply = (option) => {
                scope.onDone(option.result);
            };
            scope.back = () => {
                scope.state = 'pick';
                scope.options = [];
            };
            scope.cancel = () => {
                scope.onDone(null);
            };

            load();
            baselineOf();
        },
    };
};
