/*
 * The show the checklist's breaks-page workflow approves a weaker second line on,
 * and which Approve button in the show's line is that line's own: a show with a main
 * pattern has two Approve buttons (the main line's, then the weaker's), a show with only
 * the weaker line has one. `shows` is /api/breaks/shows' list; answers
 * { show, nth } (nth counts the visible Approve buttons in the line), or null.
 */
module.exports = function pickWeakerLine(shows) {
    const show = shows.find( (s) => s.weaker !== null && !s.approved && s.kind !== 'movie' );
    if (typeof(show) === 'undefined') {
        return null;
    }
    return { show, nth: (show.pattern !== null) ? 1 : 0 };
};
