/*
 * scripts/lib/weaker-line.js: the checklist's breaks-page workflow approves a show's
 * weaker second line from the show's own line. A show with no main pattern shows only
 * the weaker line, so its Approve is the first Approve button in the line, not the
 * second. The workflow always asked for the second, and failed ("The Wizard of Oz
 * (1990) has no /^Approve$/ button in its line", Nov 15, 2026 about 5:40am) whenever
 * such a show came first in the list; it passed when a show with both lines did.
 */
const { Suite } = require('./support');
const pickWeakerLine = require('../scripts/lib/weaker-line');

const show = (name, pattern, weaker, extra) => Object.assign({ name, key: name, kind: 'tv', pattern, weaker, approved: false }, extra);

module.exports = async function run() {
    const suite = new Suite('weaker-line-pick');

    const only = show('The Wizard of Oz (1990)', null, '1 break an episode at different times (weaker points, 7 of 13)');
    const both = show('The Wuzzles', 'opening near 1:12 (89%)', 'opening near 1:12 (89%), 1 break an episode at different times (weaker points, 7 of 9)');

    let pick = pickWeakerLine([ only, both ]);
    suite.check('a show with only the weaker line comes first: it is picked', pick !== null && pick.show === only);
    suite.check('...and its Approve is the first button in its line', pick !== null && pick.nth === 0, pick && pick.nth);

    pick = pickWeakerLine([ both, only ]);
    suite.check('a show with both lines: its weaker Approve is the second button', pick !== null && pick.show === both && pick.nth === 1, pick && pick.nth);

    pick = pickWeakerLine([
        show('Already approved', 'a', 'b', { approved: true }),
        show('A movie', null, 'b', { kind: 'movie' }),
        show('No weaker line', 'a', null),
        both,
    ]);
    suite.check('approved shows, movies and shows with no weaker line are passed over', pick !== null && pick.show === both);

    suite.check('nothing on offer answers null', pickWeakerLine([ show('No weaker line', 'a', null) ]) === null);
    return suite;
};
