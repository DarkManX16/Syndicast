/*
 * Swap an airing for another episode or item, pinned to its date and time
 * (src/pins.js). The dialog's re-lays are planned once, as it opens, by the
 * Time Slots editor (plan), and run in the re-lay worker (src/relay-worker.js,
 * off the page's main thread): the lineup without the swap, then for a pick
 * the lineup with it - twice when it runs into the next slot, once each way.
 * The dialog says in plain words what each choice does, first whatever pushes
 * a pin late or costs a show its slot; choosing one hands that re-lay to the
 * channel page, which applies it as Create Lineup's result. See NOTES.md,
 * Known issues, "Swaps, inserts and Flex that keeps time".
 *
 * `request`: { channel, index, mode, plan, catalogState } from the channel
 * page; `onDone(result | null)`.
 */
const pins = require('../../src/pins');
const showCatalog = require('../../src/show-catalog');
const constants = require('../../src/constants');
const rounds = require('../../src/shuffle-rounds');
const swapRead = require('../../src/swap-read');

const SAME = 2000;

module.exports = function ($timeout, dizquetv, getShowData, commonProgramTools, catalogReader, relayWorker) {
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
            let customFromLineup = false;

            // When the lineup re-made without the swap still has a program on at `at`,
            // where that ends: an item can only start then (see baselineFor).
            let heldUntil = null;
            let describe = (p) => {
                let fit = pins.fitAt({ programs: channel.programs, startTime: startTime(), schedule, at, duration: p.duration });
                let overrun = (heldUntil === null) ? fit.overrun : Math.max(0, heldUntil + p.duration - fit.slotEnd);
                return {
                    program: p,
                    label: pins.label(p),
                    length: pins.length(p.duration),
                    holiday: showCatalog.holidayOf(p.title),
                    fits: overrun <= constants.SLACK,
                    over: pins.length(overrun),
                    late: (heldUntil === null) ? '' : `starts late, at ${pins.clock(heldUntil)}`,
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
            scope.visible = (row) => {
                let f = scope.filter.text.trim().toLowerCase();
                return (f === '') || row.label.toLowerCase().includes(f) || (row.holiday && row.holiday.toLowerCase().includes(f));
            };

            // What the dialog is doing while it works, in a line.
            scope.progress = 'Working it out...';
            let say = (text) => {
                scope.progress = text;
                $timeout();
            };
            // Every re-lay of this dialog is planned once, as of the moment it opened: the
            // pool, every position's place and the program on air are the same for each.
            let relayNow = Date.now();
            let session = `swap-${relayNow}-${Math.random().toString(36).slice(2)}`;
            // Its own worker, loading while the re-lays are planned.
            relayWorker.begin(session);
            let planned = null;
            let planOf = () => {
                if (planned === null) {
                    planned = (async () => {
                        let t0 = Date.now();
                        say('Getting the lineup ready...');
                        let made = await req.plan({
                            programs: commonProgramTools.slotPool(channel.programs), limit: req.limit,
                            backup: schedule, lineup: lineupNow, catalogState: await req.catalogState(), now: relayNow,
                            onReading: (count) => say(`Reading ${count} ${ (count === 1) ? "show's catalog" : "shows' catalogs" } from Plex...`),
                        });
                        await relayWorker.open(session, made.inputs, { programs: channel.programs, startTime: startTime() });
                        console.log(`Swap: planned the re-lays in ${Date.now() - t0} ms`);
                        return made;
                    })();
                    planned.catch( () => { planned = null; } );
                }
                return planned;
            };
            // One re-lay in the worker, kept there by `key`; asked again with the same pins, not re-made.
            let relayIn = async (key, list, what) => {
                await planOf();
                say(what);
                let t0 = Date.now();
                let got = await relayWorker.call({ type: 'relay', session, key, pins: list });
                console.log(`Swap: re-laid the lineup (${key}) in ${Date.now() - t0} ms${got.cached ? ', kept from before' : ''}`);
                return got;
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
                    baseline = relayIn('base', ahead(), 'Re-making the lineup as it is...');
                    baseline.catch( () => { baseline = null; } );
                }
                return baseline;
            };
            // What the lineup without the swap says about `at` - asked again when an insert moves.
            let said = new Map();
            let baselineFor = async (instant) => {
                await baselineOf();
                if (! said.has(instant)) {
                    said.set(instant, await relayWorker.call({ type: 'baseline', session, key: 'base', now: relayNow, at: instant }));
                }
                return said.get(instant);
            };
            let relayWith = async (pin, what) => {
                let base = await baselineFor(at);
                let key = `${pin.pin.then}|${pin.pin.at}|${rounds.fileKey(pin)}`;
                await relayIn(key, pins.withPin(ahead(), pin), what);
                say('Working out what changes...');
                let mine = await relayWorker.call({ type: 'option', session, key, base: 'base', now: relayNow, at, item: pin, kind: pin.pin.kind });
                return { key, placed: mine.placed, fitText: mine.fitText, effects: mine.effects, onAir: base.anyway, dropped: base.dropped,
                    alerts: mine.alerts.filter( (a) => ! base.alerts.includes(a) ), anywayAlerts: base.alerts };
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
                    let take = await relayWith(make('take'), `Re-making the lineup with ${p.title}...`);
                    if (! take.placed) {
                        // The generator leaves out a pin it can't place: never apply a re-lay without it.
                        scope.error = `The lineup can't hold ${p.title} at ${pins.dayClock(at)}: it is past the end of what Create Lineup makes (${schedule.maxDays} days), or the lineup is full. Nothing was changed.`;
                        scope.state = 'pick';
                        return;
                    }
                    let fit = pins.fitAt({ programs: channel.programs, startTime: startTime(), schedule, at, duration: p.duration });
                    scope.fitText = take.fitText;
                    scope.options = [];
                    scope.breaks = [];
                    if (fit.overrun <= constants.SLACK) {
                        scope.options.push(Object.assign({ label: isInsert ? 'Insert' : 'Swap' }, take));
                    } else {
                        let late = await relayWith(make('late'), `Re-making the lineup with ${p.title} running late...`);
                        let into = fit.runsInto ? ` ${pins.clock(fit.slotEnd)} slot` : ' next slot';
                        let takeOver = Object.assign({ label: `Take over the${into}` }, take);
                        let runLate = late.placed ? Object.assign({ label: 'Run late' }, late) : null;
                        // An insert's first choice is to run late: it is the shortest way to
                        // keep what follows; a swap's is to take the slot over.
                        let ordered = isInsert ? [ runLate, takeOver ] : [ takeOver, runLate ];
                        ordered.forEach( (o) => { if (o !== null) { scope.options.push(o); } } );
                        if (isInsert) {
                            scope.breaks = pins.breaksThatFit({ programs: channel.programs, startTime: startTime(), near: at, within: 12 * 60 * 60 * 1000, duration: p.duration, notBefore: Date.now() })
                                .filter( (b) => Math.abs(b.start - at) > SAME )
                                .map( (b) => ({ start: b.start, text: `${pins.dayClock(b.start)}, after ${pins.label(b.after.program)} - a break of ${pins.length(b.length)}`, after: b.after.program, afterStart: b.after.start, length: b.length }) );
                        }
                    }
                    let dropped = scope.options[0].dropped;
                    let firstSwap = ahead().length === 0 && ! channel.programs.some( (x) => x.pin );
                    scope.warning = (firstSwap || dropped.length > 0)
                        ? (firstSwap ? pins.sayFirstSwap({ dropped }) : pins.sayDropped(dropped)) : '';
                    scope.warningItems = pins.droppedBehind(dropped);
                    scope.showWarningItems = false;
                    // Said first, before any choice: a pin pushed late, a show losing its slot.
                    scope.alerts = scope.options[0].anywayAlerts.map( (a) => 'Re-making the lineup now, with or without this: ' + a )
                        .concat( (scope.options.length === 1)
                            ? scope.options[0].alerts
                            : [].concat(...scope.options.map( (o) => o.alerts.map( (a) => `If you choose "${o.label}": ${a}` ) )) );
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
            scope.putInBreak = async (b) => {
                let was = { at: at, afterStart: afterStart, afterProgram: scope.afterProgram, breakLength: scope.breakLength };
                at = b.start;
                afterStart = b.afterStart;
                scope.afterProgram = b.after;
                scope.breakLength = b.length;
                retitle();
                // The dialog's own re-lays are planned from the lineup as it is; only the pin moves.
                await scope.choose(scope.chosen);
                if (scope.state !== 'choose') {
                    // Refused or failed: the dialog stays pointed at the break it was.
                    at = was.at;
                    afterStart = was.afterStart;
                    scope.afterProgram = was.afterProgram;
                    scope.breakLength = was.breakLength;
                    retitle();
                    $timeout();
                }
            };
            // The chosen lineup comes back from the worker only now, with what the plan hands back with it.
            scope.apply = async (option) => {
                scope.state = 'working';
                say('Putting it in the list...');
                try {
                    let made = await planOf();
                    let result = await relayWorker.call({ type: 'result', session, key: option.key });
                    close();
                    scope.onDone(Object.assign(result, { schedule: JSON.parse(JSON.stringify(made.schedule)), catalogOps: made.catalogOps }));
                } catch (err) {
                    console.error(err);
                    scope.error = 'The lineup could not be put in the list: ' + ( (err && err.message) || err );
                    scope.state = 'choose';
                    $timeout();
                }
            };
            scope.back = () => {
                scope.state = 'pick';
                scope.options = [];
            };
            let closed = false;
            let close = () => {
                if (! closed) {
                    closed = true;
                    relayWorker.call({ type: 'close', session }).catch( () => null );
                }
            };
            scope.cancel = () => {
                close();
                scope.onDone(null);
            };
            scope.$on('$destroy', close);

            load();
            // The lineup without the swap, worked out while Ron picks; then the picker's
            // "fits" counts from wherever a program still on would hold the item back.
            scope.preparing = true;
            baselineFor(at).then( (base) => {
                heldUntil = base.heldUntil;
                // Only the fit is worked out again: a holiday row keeps its own label, and no program until picked.
                scope.items.forEach( (r) => {
                    let d = describe(r.program || { title: r.label, duration: r.entry.duration });
                    Object.assign(r, { fits: d.fits, over: d.over, late: d.late });
                } );
                $timeout();
            } ).catch( (err) => console.error(err) ).then( () => {
                scope.preparing = false;
                $timeout();
            } );
        },
    };
};
