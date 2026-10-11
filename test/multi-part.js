/*
 * src/multi-part.js: which episodes are parts of one story, so every shuffle
 * keeps part 2 right after part 1. Fixtures are real titles from Ron's
 * channels, in their shows' order. See NOTES.md, Known issues, "Per-position
 * stored progress, and the shuffles built on it".
 */
const { MIN, Suite } = require('./support');
const multiPart = require('../src/multi-part');

let n = 0;
function ep(title) {
    n++;
    return { type: 'episode', showTitle: 'Show', title, season: 1, episode: n, duration: 22 * MIN, serverKey: 'srv', key: '/e/' + n };
}
const shape = (titles) => multiPart.stories(titles.map(ep)).map((story) => story.map((p) => p.title));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = async function () {
    const suite = new Suite('multi-part');

    suite.log('-- part markers --');
    suite.check('"(2)" is part 2', same(multiPart.partOf('Deadomutt (2)'), { base: 'Deadomutt', n: 2 }), JSON.stringify(multiPart.partOf('Deadomutt (2)')));
    suite.check('"Part Two", "Part II", "Pt. 3" and "(II)" are parts',
        multiPart.partOf('Rearview Mirror, Mirror (Part Two)').n === 2
            && multiPart.partOf('Escape to the House of Mummies Part II').n === 2
            && multiPart.partOf('Brainwashed Pt. 3: Wash Harder').n === 3
            && multiPart.partOf('Seahorse Seashell Party (II)').n === 2);
    suite.check('a nine-part arc counts to nine', multiPart.partOf('Primal Desire: The Struggle for Trost (9)').n === 9);
    suite.check('The Thirteen Ghosts (1975) is not a part', multiPart.partOf('The Thirteen Ghosts (1975)') === null);
    suite.check('a title with no marker is not a part', multiPart.partOf('Assassinanny 911') === null);

    suite.log('-- stories --');
    suite.check('Deadomutt (1)/(2) join', same(shape(['Deadomutt (1)', 'Deadomutt (2)', 'Very Personal Injury']),
        [['Deadomutt (1)', 'Deadomutt (2)'], ['Very Personal Injury']]));
    suite.check('Stewie Kills Lois (1) and Lois Kills Stewie (2) join',
        same(shape(['Stewie Kills Lois (1)', 'Lois Kills Stewie (2)']), [['Stewie Kills Lois (1)', 'Lois Kills Stewie (2)']]));
    suite.check('Judging, Saving and Finding Omi make one story of three',
        same(shape(['Judging Omi (1)', 'Saving Omi (2)', 'Finding Omi (3)']), [['Judging Omi (1)', 'Saving Omi (2)', 'Finding Omi (3)']]));
    suite.check('Secret Origins, (2), (3) make one',
        same(shape(['Secret Origins', 'Secret Origins (2)', 'Secret Origins (3)', 'In Blackest Night (1)']),
            [['Secret Origins', 'Secret Origins (2)', 'Secret Origins (3)'], ['In Blackest Night (1)']]));
    suite.check('Escape to the House of Mummies Part II after Assassinanny 911 stays single',
        same(shape(['Assassinanny 911', 'Escape to the House of Mummies Part II']),
            [['Assassinanny 911'], ['Escape to the House of Mummies Part II']]));
    suite.check('Sonic Underground\'s interleaved arcs stay single',
        same(shape(['Wedding Bell Blues', 'No Hedgehog Is an Island (Chaos Emerald Crisis, Part 2)', 'Getting to Know You (Origins, Part 2)']),
            [['Wedding Bell Blues'], ['No Hedgehog Is an Island (Chaos Emerald Crisis, Part 2)'], ['Getting to Know You (Origins, Part 2)']]));
    // The real order: two arcs, each naming itself in brackets, alternating.
    suite.check('...all four of them, though Part 3 follows a Part 2',
        same(shape(['No Hedgehog Is an Island (Chaos Emerald Crisis, Part 2)', 'Getting to Know You (Origins, Part 2)',
            'New Echidna in Town (Chaos Emerald Crisis, Part 3)', 'Harmony or Something (Origins, Part 3)']),
        [['No Hedgehog Is an Island (Chaos Emerald Crisis, Part 2)'], ['Getting to Know You (Origins, Part 2)'],
            ['New Echidna in Town (Chaos Emerald Crisis, Part 3)'], ['Harmony or Something (Origins, Part 3)']]));
    suite.check('...while one arc in order still joins',
        same(shape(['Wedding (Origins, Part 1)', 'Getting to Know You (Origins, Part 2)']),
            [['Wedding (Origins, Part 1)', 'Getting to Know You (Origins, Part 2)']]));
    suite.check('every program is in exactly one story',
        multiPart.stories(['A (1)', 'A (2)', 'B', 'C (1)', 'D'].map(ep)).reduce((count, story) => count + story.length, 0) === 5);
    suite.check('an empty show has no stories', multiPart.stories([]).length === 0);

    return suite;
};
