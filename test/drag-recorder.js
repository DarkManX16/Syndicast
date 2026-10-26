/*
 * web/services/drag-recorder.js: what Edge actually hands the page during a
 * drag, kept across reloads, so the next time dragging shows 🚫 everywhere
 * we can see which step stopped. See NOTES.md > "Dragging a program row
 * can't shed its row mid-drag" (corrected Oct 25, 2026).
 *
 * The recorder listens on window in the capture phase, so it sees each
 * event before the page's own drag lists do; whether the page accepted a
 * drag-over (preventDefault) is only known after they run, so that read is
 * deferred. Here the target, the storage and that deferral are stand-ins
 * the test drives by hand.
 */
const { Suite } = require('./support');
const makeDragRecorder = require('../web/services/drag-recorder');

function fakeWindow() {
    const handlers = {};
    return {
        addEventListener: (type, fn, capture) => { (handlers[type] = handlers[type] || []).push({ fn, capture }); },
        removeEventListener: (type, fn) => { handlers[type] = (handlers[type] || []).filter((h) => h.fn !== fn); },
        handlers,
    };
}

function fakeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        map: m,
    };
}

const row = { closest: (sel) => (sel === '[draggable="true"]' ? row : null) };
const plain = { closest: () => null };

function rig(storage) {
    const win = fakeWindow();
    const queue = [];
    let t = Date.parse('2026-10-25T05:14:03.000Z');
    const rec = makeDragRecorder({
        target: win,
        storage: storage || fakeStorage(),
        now: () => t,
        defer: (fn) => queue.push(fn),
        where: () => '#!/filler',
        agent: 'Mozilla/5.0 Chrome/156.0.0.0 Edg/156.0.4314.42',
    });
    // Dispatches like the browser: the recorder's capture listener first,
    // then `page` (the drag list's own handler), then whatever was deferred.
    const fire = (type, props, page) => {
        const ev = Object.assign({ type, target: row, button: 0, clientX: 0, clientY: 0, defaultPrevented: false }, props || {});
        ev.preventDefault = () => { ev.defaultPrevented = true; };
        (win.handlers[type] || []).forEach((h) => h.fn(ev));
        if (page) page(ev);
        while (queue.length) queue.shift()();
        t += 50;
        return ev;
    };
    const dt = (types, extra) => Object.assign({ types: types || [], effectAllowed: 'uninitialized', dropEffect: 'none' }, extra || {});
    return { win, rec, fire, dt };
}

// One ordinary reorder, the way a real Edge 156 drag arrived in the
// real-mouse runs (pointercancel right after dragstart, no mouseup).
function goodDrag(r) {
    const { fire, dt } = r;
    fire('mousedown', { clientX: 10, clientY: 10 });
    fire('mousemove', { clientX: 14, clientY: 22 });
    fire('dragstart', { dataTransfer: dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; ev.dataTransfer.effectAllowed = 'move'; });
    fire('pointercancel');
    for (let i = 0; i < 3; i++) {
        fire('dragenter', { dataTransfer: dt(['application/x-dnd']) }, (ev) => ev.preventDefault());
        fire('dragover', { dataTransfer: dt(['application/x-dnd']) }, (ev) => ev.preventDefault());
    }
    fire('drop', { dataTransfer: dt(['application/x-dnd'], { dropEffect: 'move' }) }, (ev) => ev.preventDefault());
    fire('dragend', { dataTransfer: dt(['application/x-dnd'], { dropEffect: 'move' }) });
}

module.exports = async function () {
    const suite = new Suite('drag-recorder');

    suite.log('-- an ordinary drag --');
    {
        const r = rig();
        goodDrag(r);
        const s = r.rec.sessions();
        suite.check('one drag is one entry', s.length === 1, JSON.stringify(s));
        const d = s[0];
        suite.check('...with the types the page set, read after its own dragstart ran',
            JSON.stringify(d.typesSet) === '["application/x-dnd"]' && d.allowed === 'move', JSON.stringify(d));
        suite.check('...every drag-over counted, and each one the page accepted', d.over === 3 && d.accepted === 3, `${d.over}/${d.accepted}`);
        suite.check('...a drop and a drag end, with its effect', d.drop === true && d.dragend === true && d.dropEffect === 'move');
        // stamped at dragstart, the third event (the rig steps 50 ms per event)
        suite.check('...where and when', d.where === '#!/filler' && d.at === '2026-10-25T05:14:03.100Z', d.where + ' ' + d.at);
        suite.check('verdict: ok', r.rec.verdict(d).startsWith('ok'), r.rec.verdict(d));
    }

    suite.log('-- what a lockup could look like --');
    {
        const r = rig();
        const { fire, dt } = r;
        fire('mousedown');
        fire('dragstart', { dataTransfer: dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; });
        for (let i = 0; i < 4; i++) {
            fire('dragover', { dataTransfer: dt(['application/x-dnd']) }); // nobody accepts
        }
        fire('dragend', { dataTransfer: dt(['application/x-dnd']) });
        const d = r.rec.sessions()[0];
        suite.check('drag-overs nobody accepted: refused', d.over === 4 && d.accepted === 0 && /refused/.test(r.rec.verdict(d)), r.rec.verdict(d));
    }
    {
        const r = rig();
        const { fire, dt } = r;
        fire('mousedown');
        fire('dragstart', { dataTransfer: dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; });
        fire('dragover', { dataTransfer: dt([]) });
        fire('dragend', { dataTransfer: dt([]) });
        const d = r.rec.sessions()[0];
        suite.check('drag-overs that arrive with no data say so', /no data/.test(r.rec.verdict(d)), r.rec.verdict(d));
    }
    {
        // The drag library takes a drag it started itself even when Edge hands it back empty.
        const r = rig();
        const { fire, dt } = r;
        fire('mousedown');
        fire('dragstart', { dataTransfer: dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; });
        fire('dragover', { dataTransfer: dt([]) }, (ev) => ev.preventDefault());
        fire('drop', { dataTransfer: dt([]) }, (ev) => ev.preventDefault());
        fire('dragend', { dataTransfer: dt([]) });
        const d = r.rec.sessions()[0];
        suite.check('a drag Edge handed back empty that the page took anyway says both',
            /^ok/.test(r.rec.verdict(d)) && /no data/.test(r.rec.verdict(d)), r.rec.verdict(d));
    }
    {
        const r = rig();
        const { fire } = r;
        fire('mousedown', { clientX: 10, clientY: 10 });
        fire('mousemove', { clientX: 10, clientY: 60 });
        fire('mouseup', { clientX: 10, clientY: 60 });
        const d = r.rec.sessions()[0];
        suite.check('pressed and moved a draggable row, no dragstart: Edge never started it',
            d && d.dragstart === false && /never started/.test(r.rec.verdict(d)), d && r.rec.verdict(d));
        fire('mousedown', { clientX: 10, clientY: 10 });
        fire('mouseup', { clientX: 11, clientY: 10 });
        suite.check('...but a plain click on a row is not a drag', r.rec.sessions().length === 1, String(r.rec.sessions().length));
        fire('mousedown', { target: plain, clientX: 10, clientY: 10 });
        fire('mousemove', { target: plain, clientX: 10, clientY: 90 });
        fire('mouseup', { target: plain });
        suite.check('...nor a press-and-move on something not draggable (selecting text)', r.rec.sessions().length === 1, String(r.rec.sessions().length));
    }
    {
        const r = rig();
        const { fire, dt } = r;
        fire('mousedown');
        fire('dragstart', { dataTransfer: dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; });
        fire('mousedown'); // the next try, with no drag-over and no dragend from the first
        const d = r.rec.sessions()[0];
        suite.check('a started drag that got no drag-over and never ended says both',
            /no drag-over/.test(r.rec.verdict(d)) && /never ended/.test(r.rec.verdict(d)), r.rec.verdict(d));
    }

    suite.log('-- kept across a reload --');
    {
        const storage = fakeStorage();
        const a = rig(storage);
        goodDrag(a);
        a.fire('mousedown');
        a.fire('dragstart', { dataTransfer: a.dt([]) }, (ev) => { ev.dataTransfer.types = ['application/x-dnd']; });
        // the page reloads mid-drag: nothing more reaches this recorder
        a.rec.stop();
        const b = rig(storage);
        const s = b.rec.sessions();
        suite.check('a fresh page reads back what the last one recorded, the unfinished drag included',
            s.length === 2 && s[1].dragstart === true && s[1].dragend === false, JSON.stringify(s.map((x) => b.rec.verdict(x))));
        goodDrag(b);
        suite.check('...and adds to it', b.rec.sessions().length === 3);
        b.rec.clear();
        suite.check('Clear empties it, stored copy included', b.rec.sessions().length === 0 && rig(storage).rec.sessions().length === 0);
    }
    {
        const r = rig();
        for (let i = 0; i < 45; i++) goodDrag(r);
        suite.check('keeps the last 40 drags', r.rec.sessions().length === 40);
    }
    {
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
        let ok = true;
        let r;
        try {
            r = rig(broken);
            goodDrag(r);
            r.rec.clear();
        } catch (e) {
            ok = false;
        }
        suite.check('storage that throws never breaks a drag', ok && r.rec.sessions().length === 0);
    }

    suite.log('-- the copy for Ron to paste --');
    {
        const r = rig();
        goodDrag(r);
        const text = r.rec.text();
        suite.check('names the browser and each drag on its own line',
            /Edg\/156\.0\.4314\.42/.test(text) && /#!\/filler/.test(text) && /ok/.test(text), text);
        r.rec.stop();
        const before = r.rec.sessions().length;
        r.fire('mousedown');
        r.fire('dragstart', { dataTransfer: r.dt([]) });
        suite.check('stop() takes its listeners off', r.rec.sessions().length === before);
    }

    return suite;
};
