/*
 * A swap's re-lays, off the page's main thread: run in a Web Worker made from
 * the page's own bundle (web/app.js), or in the page when there is no worker.
 *
 * The editor plans a dialog's re-lays once - the pool, the schedule with every
 * position's place, history, the program on air - and opens a session with
 * them and the lineup as it is. Each re-lay then only adds pins: the Time Slots
 * generator runs here and the lineup it makes stays here, keyed. What the
 * dialog says about each is worked out here too, and only the lineup chosen
 * goes back to the page. Before, every re-lay read Plex again, planned again,
 * and sent the server 20 MB to get 26 MB back. See NOTES.md, "Swaps, inserts
 * and Flex that keeps time".
 *
 * Messages, each answered with a value or an error:
 *   open     { session, inputs: { pool, schedule, history, carry }, current: { programs, startTime } }
 *   add      { session, part: 'pool' | 'current', items } - more of the pool or the lineup, handed
 *            over in slices (slices) so the page never stops for the whole copy at once
 *   relay    { session, key, pins }  -> { placed, missing: [at], cached }
 *   baseline { session, key, now, at } -> { anyway, dropped, alerts, heldUntil }
 *   option   { session, key, base, now, at, item, kind } -> { effects, alerts, fitText, placed }
 *   result   { session, key } -> the generator's result: { programs, startTime, ... }
 *   close    { session }
 */
const pins = require('./pins');
const constants = require('./constants');

const SAME = 2000;
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 400 * DAY;
// How far ahead a lost slot is looked for: a pin pushes what follows it for an evening at most.
const WARN = 2 * DAY;

const clone = (x) => (typeof(x) === 'undefined') ? undefined : JSON.parse(JSON.stringify(x));

// What re-making the lineup changes with or without the swap, and what holds its pin back.
function baselineSay({ current, base, now, at, schedule, getShowData }) {
    let anyway = pins.relayEffects({ before: current, after: base, from: now, to: now + YEAR, schedule, getShowData });
    let on = pins.walk(base.programs, base.startTime, at - SAME, at + 1)
        .filter( (x) => ! x.program.isOffline && (x.start < at - SAME) && (x.start + x.program.duration > at + constants.SLACK) ).pop();
    return {
        anyway: ( (anyway.movedAlong.length + anyway.late.length + anyway.early.length) > 0 )
            ? 'Re-making the lineup now also changes, with or without this swap: ' + pins.sayEffects(anyway) : '',
        dropped: anyway.dropped,
        alerts: pins.sayWarnings(pins.slotWarnings({ before: current, after: base, from: now, to: now + WARN, schedule, getShowData })),
        heldUntil: on ? on.start + on.program.duration : null,
    };
}

// What one choice does, against the same re-lay without the new pin.
function optionSay({ current, base, mine, now, at, schedule, item, kind, getShowData }) {
    let own = pins.relayEffects({ before: base, after: mine, from: Math.max(now, at - SAME), to: now + YEAR, schedule, getShowData });
    return {
        effects: pins.sayEffects(own),
        alerts: pins.sayWarnings(pins.slotWarnings({ before: base, after: mine, from: now, to: now + WARN, schedule, getShowData, own: at })),
        fitText: pins.sayFit({ programs: current.programs, startTime: current.startTime, schedule, at, item, kind, after: mine }),
        placed: pins.placedIn(mine, at),
    };
}

// `generate({ pool, schedule, history, pins, carry })` is the Time Slots generator.
function handler({ generate, getShowData }) {
    let sessions = new Map();
    let sessionOf = (id) => {
        let s = sessions.get(id);
        if (typeof(s) === 'undefined') {
            throw new Error(`No re-lay session "${id}": it was closed.`);
        }
        return s;
    };
    let madeOf = (s, key) => {
        let m = s.made.get(key);
        if (typeof(m) === 'undefined') {
            throw new Error(`No re-lay "${key}" in this session.`);
        }
        return m;
    };
    let placedOf = (lineup, list) => {
        let missing = list.filter( (x) => ! pins.placedIn(lineup, x.at) ).map( (x) => x.at );
        return { placed: missing.length === 0, missing };
    };
    return async (msg) => {
        if (msg.type === 'open') {
            sessions.set(msg.session, { inputs: msg.inputs, current: msg.current, made: new Map() });
            return { opened: msg.session };
        }
        if (msg.type === 'close') {
            sessions.delete(msg.session);
            return { closed: msg.session };
        }
        let s = sessionOf(msg.session);
        let schedule = s.inputs.schedule;
        if (msg.type === 'add') {
            let list = (msg.part === 'pool') ? s.inputs.pool : s.current.programs;
            for (let i = 0; i < msg.items.length; i++) {
                list.push(msg.items[i]);
            }
            return { length: list.length };
        }
        if (msg.type === 'relay') {
            let signature = JSON.stringify(msg.pins || []);
            let had = s.made.get(msg.key);
            if ( (typeof(had) !== 'undefined') && (had.signature === signature) ) {
                return Object.assign({ cached: true }, placedOf(had.lineup, msg.pins || []));
            }
            let res = await generate({ pool: clone(s.inputs.pool), schedule: clone(schedule), history: clone(s.inputs.history) || [],
                pins: clone(msg.pins || []), carry: clone(s.inputs.carry) });
            if (typeof(res.userError) !== 'undefined') {
                throw new Error(res.userError);
            }
            let lineup = { programs: res.programs, startTime: new Date(res.startTime).getTime() };
            s.made.set(msg.key, { res, lineup, signature });
            return Object.assign({ cached: false }, placedOf(lineup, msg.pins || []));
        }
        if (msg.type === 'baseline') {
            return baselineSay({ current: s.current, base: madeOf(s, msg.key).lineup, now: msg.now, at: msg.at, schedule, getShowData });
        }
        if (msg.type === 'option') {
            return optionSay({ current: s.current, base: madeOf(s, msg.base).lineup, mine: madeOf(s, msg.key).lineup,
                now: msg.now, at: msg.at, schedule, item: msg.item, kind: msg.kind, getShowData });
        }
        if (msg.type === 'result') {
            return madeOf(s, msg.key).res;
        }
        throw new Error(`Unknown re-lay message "${msg.type}".`);
    };
}

// A list in slices of at most `n`, in order: what the page hands over one message at a time.
function slices(list, n) {
    let out = [];
    for (let i = 0; i < list.length; i += n) {
        out.push(list.slice(i, i + n));
    }
    return out;
}

// In a Web Worker: answer the page's messages, { id, msg } -> { id, ok, value | error }.
function listen(scope) {
    const timeSlotsService = require('./services/time-slots-service');
    let handle = handler({
        generate: (a) => timeSlotsService(a.pool, a.schedule, a.history, a.pins, a.carry),
        getShowData: require('./services/get-show-data')(),
    });
    scope.onmessage = async (e) => {
        let { id, msg } = e.data;
        try {
            scope.postMessage({ id, ok: true, value: await handle(msg) });
        } catch (err) {
            scope.postMessage({ id, ok: false, error: (err && err.message) ? err.message : String(err) });
        }
    };
}

module.exports = { handler, listen, slices, baselineSay, optionSay };
