/*
 * Which episodes are parts of one story, so every shuffle keeps part 2 right
 * after part 1. Pure, shared by the generators and the editor.
 *
 * An episode marked part n (n of 2 or more) belongs with the one right before
 * it in its show's order when that one is marked n-1 - or, for part 2, when
 * that one has the same title with no marker ("Secret Origins", then "Secret
 * Origins (2)"). Titles are not compared otherwise, because real two-parters
 * often title each part differently: "Stewie Kills Lois (1)" is followed by
 * "Lois Kills Stewie (2)". On Ron's three channels this finds 430 stories;
 * the 24 parts it leaves single are crossovers whose other parts belong to
 * another show, parts whose part 1 isn't next to them or isn't in the
 * library, and Sonic Underground's two interleaved arcs.
 *
 * See NOTES.md, Known issues, "Per-position stored progress, and the shuffles
 * built on it".
 */

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 };

function number(text) {
    return /^\d+$/.test(text) ? parseInt(text, 10) : WORDS[text.toLowerCase()];
}

/*
 * The part a title says it is: "(2)", "(II)", "Part 2", "Part Two", "Part II"
 * or "Pt. 2". A single digit in brackets, so "(1975)" is a year, not a part;
 * words and numerals run to six.
 */
function partOf(title) {
    let t = (typeof(title) === 'string') ? title.trim() : '';
    let m = t.match(/^(.*?)[\s,:\-–]*\((\d|i{1,3}|iv|v|vi)\)\s*$/i);
    if (m === null) {
        m = t.match(/^(.*?)[\s,:\-–(]*\bpart\s+(\d|one|two|three|four|five|six|vi|iv|v|i{1,3})\b/i);
    }
    if (m === null) {
        m = t.match(/^(.*?)[\s,:\-–]*\bpt\.?\s*(\d)\b/i);
    }
    if (m === null) {
        return null;
    }
    return { base: m[1], n: number(m[2]) };
}

const plain = (text) => (typeof(text) === 'string' ? text : '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/*
 * The arc a title names beside its part, in brackets: "Getting to Know You
 * (Origins, Part 2)" is in "Origins". Sonic Underground runs two such arcs
 * alternately, so a Part 3 straight after a Part 2 can belong to the other.
 */
function arcOf(title) {
    let m = (typeof(title) === 'string') ? title.match(/\(([^()]*?),\s*(?:part|pt\.?)\s*\w+\)\s*$/i) : null;
    return (m === null) ? null : plain(m[1]);
}

function joinsPrevious(previous, program) {
    let part = partOf(program.title);
    if ( (part === null) || (part.n < 2) ) {
        return false;
    }
    let before = partOf(previous.title);
    if (before !== null) {
        let arc = arcOf(program.title);
        let arcBefore = arcOf(previous.title);
        if ( (arc !== null) && (arcBefore !== null) && (arc !== arcBefore) ) {
            return false;
        }
        return before.n === part.n - 1;
    }
    return (part.n === 2) && (plain(part.base) === plain(previous.title));
}

/*
 * A show's episodes, in its order, grouped into stories: every episode in
 * exactly one, a single episode being a story of one.
 */
function stories(sortedPrograms) {
    let out = [];
    for (let i = 0; i < sortedPrograms.length; i++) {
        let program = sortedPrograms[i];
        if ( (out.length > 0) && joinsPrevious(sortedPrograms[i - 1], program) ) {
            out[out.length - 1].push(program);
        } else {
            out.push([ program ]);
        }
    }
    return out;
}

module.exports = {
    partOf: partOf,
    stories: stories,
};
