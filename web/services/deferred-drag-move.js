// Holds a drop's reorder until the browser has sent dragend. See NOTES.md >
// "Dragging a program row can't shed its row mid-drag" > "A drop threw
// away the row still being dragged".
//
// A drop used to reorder the list straight away, and the redraw that
// followed could delete or rebind the dragged row's element before the
// browser's dragend reached it. dragend then went to a node no longer in
// the page, so the drag library never heard the drag end (the drag log's
// "Edge never ended it"). Here the drop only records the move; it runs
// just after dragend has been dispatched, so the dragged row stays exactly
// as it was until the browser is done with it.
//
// If dragend never comes, the move runs anyway after fallbackMs, and
// onFallback lets the caller end its own drag state. A second drop before
// the first move ran (no dragend in between) runs the first one first.
module.exports = function makeDeferredDragMove(options) {
    options = options || {};
    const later = options.later || ((fn, ms) => setTimeout(fn, ms));
    const cancel = options.cancel || ((t) => clearTimeout(t));
    const fallbackMs = (typeof options.fallbackMs === 'number') ? options.fallbackMs : 1000;
    let pending = null;
    let fallback = null;

    function run() {
        if (fallback !== null) {
            cancel(fallback);
            fallback = null;
        }
        const move = pending;
        pending = null;
        if (move) {
            move();
        }
    }

    return {
        // At drop: what to do to the list once the drag is over.
        drop(move) {
            run();
            pending = move;
            fallback = later(() => {
                fallback = null;
                run();
                if (options.onFallback) {
                    options.onFallback();
                }
            }, fallbackMs);
        },
        // At dragend (from the list's dnd-dragend): run the move once this
        // dragend has finished being dispatched.
        end() {
            if (pending) {
                if (fallback !== null) {
                    cancel(fallback);
                    fallback = null;
                }
                const move = pending;
                pending = null;
                later(move, 0);
            }
        },
        pending: () => pending !== null,
    };
};
