// A drag that crosses vs-repeat's visible window - the browser auto-
// scrolling a long list near its edge, same as any ordinary scroll - makes
// Angular tear the dragged row's own DOM node out from under the browser's
// native drag session. The browser has no way to recover from that: the
// cursor gets stuck showing "not allowed" everywhere until the whole
// browser is restarted. See NOTES.md > "Dragging a program row can't shed
// its row mid-drag" for the investigation.
//
// vsRepeatOptions is the plain object already bound to a list's
// vs-repeat-options attribute (vs-repeat watches it and reacts on its own -
// see its README). Turning both options on for the duration of a drag
// keeps every row vs-repeat has already rendered in the DOM - the window
// only grows, never shrinks - instead of letting it recycle whichever row
// the user happens to be dragging. preserveLatchOnRefresh keeps that same
// widened window even if the list's own source array is swapped out from
// under it mid-drag (e.g. a lineup rebuild finishing while the user is
// still dragging).
//
// A MutationObserver is the second line of defense, for the one case the
// latch can't cover: the dragged item itself leaving the list's data (not
// just scrolling out of view). If the dragged row's node is ever removed
// anyway, this ends the drag's pinned state immediately rather than
// leaving vs-repeat's window latched open forever.
module.exports = function makeVsRepeatDragGuard(scope, vsRepeatOptions) {
    let draggedRow = null;
    let observer = null;

    function end() {
        vsRepeatOptions.latch = false;
        vsRepeatOptions.preserveLatchOnRefresh = false;
        draggedRow = null;
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    function start(event) {
        vsRepeatOptions.latch = true;
        vsRepeatOptions.preserveLatchOnRefresh = true;
        draggedRow = event.currentTarget;
        if (window.MutationObserver && draggedRow && draggedRow.parentNode && !observer) {
            observer = new MutationObserver(function () {
                if (draggedRow && !draggedRow.isConnected) {
                    scope.$applyAsync(end);
                }
            });
            observer.observe(draggedRow.parentNode, { childList: true });
        }
    }

    return { start, end };
};
