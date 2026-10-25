// Records what the browser actually hands the page during each drag, and
// keeps the last 40 in localStorage so they survive a reload. The 🚫
// lockup survives a reload and only closing all of Edge clears it, so it
// lives in Edge, not in any page state - see NOTES.md > "Dragging a program
// row can't shed its row mid-drag". When it happens again this log says
// which step stopped: Edge never starting the drag, no drag-over reaching
// the page, drag-overs arriving with no data, the page turning every one
// down, or the drag never ending. Shown and copied from the footer.
//
// Listens on window in the capture phase, so it sees each event before the
// page's drag lists do; it never cancels or changes one. Whether the page
// accepted a drag-over (preventDefault), and the types its dragstart set,
// are only known after the page's own handlers ran, so those reads are
// deferred to after the event.
const KEY = 'syndicast.dragLog';
const KEEP = 40;
const MOVE_PX = 10;

function makeDragRecorder(options) {
    options = options || {};
    const target = options.target || window;
    const now = options.now || Date.now;
    const defer = options.defer || ((fn) => setTimeout(fn, 0));
    const where = options.where || (() => window.location.hash);
    const agent = options.agent || (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    let storage = options.storage;
    if (!storage) {
        try {
            storage = window.localStorage;
        } catch (e) {
            storage = null;
        }
    }

    let log = load();
    let open = null; // the drag being recorded, until it ends or the next one starts
    let press = null; // a mouse press on a draggable row that hasn't turned into a drag yet

    function load() {
        try {
            const saved = storage && JSON.parse(storage.getItem(KEY) || '[]');
            return Array.isArray(saved) ? saved : [];
        } catch (e) {
            return [];
        }
    }

    function save() {
        try {
            if (storage) {
                storage.setItem(KEY, JSON.stringify(log));
            }
        } catch (e) {
            // full or blocked storage: the log is for diagnosis, never worth breaking a drag over
        }
    }

    function begin(fields) {
        open = Object.assign({
            at: new Date(now()).toISOString(), where: String(where() || ''),
            moved: 0, dragstart: false, fromElsewhere: false, typesSet: [], allowed: '',
            enter: 0, over: 0, accepted: 0, typesSeen: [], drop: false, dragend: false, dropEffect: '',
        }, fields);
        log.push(open);
        while (log.length > KEEP) {
            log.shift();
        }
        save();
        return open;
    }

    function types(ev) {
        return (ev.dataTransfer && ev.dataTransfer.types) ? Array.from(ev.dataTransfer.types) : [];
    }

    function seen(s, ev) {
        types(ev).forEach((t) => {
            if (s.typesSeen.indexOf(t) === -1) {
                s.typesSeen.push(t);
            }
        });
    }

    const on = {
        mousedown: (ev) => {
            if (ev.button !== 0) {
                return;
            }
            open = null;
            const row = ev.target && ev.target.closest && ev.target.closest('[draggable="true"]');
            press = row ? { x: ev.clientX, y: ev.clientY, moved: 0 } : null;
        },
        mousemove: (ev) => {
            if (press) {
                press.moved = Math.max(press.moved, Math.round(Math.hypot(ev.clientX - press.x, ev.clientY - press.y)));
            }
        },
        mouseup: (ev) => {
            if (press) {
                on.mousemove(ev);
                if (press.moved >= MOVE_PX) {
                    begin({ moved: press.moved });
                    open = null;
                }
            }
            press = null;
        },
        dragstart: (ev) => {
            const s = begin({ dragstart: true, moved: press ? press.moved : 0 });
            press = null;
            defer(() => {
                s.typesSet = types(ev);
                s.allowed = (ev.dataTransfer && ev.dataTransfer.effectAllowed) || '';
                save();
            });
        },
        dragenter: (ev) => {
            const s = open || begin({ fromElsewhere: true });
            s.enter++;
            seen(s, ev);
            save();
        },
        dragover: (ev) => {
            const s = open || begin({ fromElsewhere: true });
            s.over++;
            seen(s, ev);
            defer(() => {
                if (ev.defaultPrevented) {
                    s.accepted++;
                }
                if (s.over === 1) {
                    save();
                }
            });
        },
        drop: (ev) => {
            const s = open || begin({ fromElsewhere: true });
            s.drop = true;
            seen(s, ev);
            save();
        },
        dragend: (ev) => {
            const s = open || begin({});
            s.dragend = true;
            s.dropEffect = (ev.dataTransfer && ev.dataTransfer.dropEffect) || '';
            open = null;
            save();
        },
    };

    Object.keys(on).forEach((type) => target.addEventListener(type, on[type], true));

    function verdict(s) {
        if (!s.dragstart && !s.fromElsewhere) {
            return `Edge never started a drag: a draggable row was pressed and moved ${s.moved}px`;
        }
        const problems = [];
        if (s.enter + s.over === 0) {
            problems.push('no drag-over reached the page');
        } else if (s.over > 0 && s.accepted === 0) {
            problems.push('refused: the page turned down every spot it crossed (🚫)'
                + (s.typesSeen.length === 0 ? ', and its drag-overs carried no data' : ''));
        }
        if (!s.dragend && !s.fromElsewhere) {
            problems.push('Edge never ended it (no dragend)');
        }
        if (problems.length > 0) {
            return problems.join('; ');
        }
        return s.drop ? 'ok' : 'ok, let go outside a list or with Esc (no drop)';
    }

    function line(s) {
        return `${new Date(s.at).toLocaleString()}  ${s.where || '(no page)'}  ${verdict(s)}`
            + `  [${s.fromElsewhere ? 'came from outside this page' : 'start types: ' + (s.typesSet.join(',') || 'none') + ', allowed ' + (s.allowed || '?')}`
            + `; enter ${s.enter}, over ${s.over} (accepted ${s.accepted}), types seen ${s.typesSeen.join(',') || 'none'}`
            + `; drop ${s.drop ? 'yes' : 'no'}; end ${s.dragend ? (s.dropEffect || 'none') : 'never'}]`;
    }

    return {
        sessions: () => log.slice(),
        verdict,
        line,
        text: () => [`Syndicast drag log, copied ${new Date(now()).toLocaleString()}`, `Browser: ${agent}`]
            .concat(log.slice().reverse().map(line)).join('\n'),
        clear: () => {
            log = [];
            open = null;
            press = null;
            try {
                if (storage) {
                    storage.removeItem(KEY);
                }
            } catch (e) {
                // nothing stored to clear
            }
        },
        stop: () => Object.keys(on).forEach((type) => target.removeEventListener(type, on[type], true)),
    };
}

module.exports = makeDragRecorder;
