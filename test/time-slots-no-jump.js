/*
 * The Time Slots dialog does not move under a click while it reads the shows' episode lists
 * (docs/blocks-spec.md, Stage 6, build order 5d; NOTES.md, "Step 5d").
 *
 * Measured Nov 15 (scripts/click-probe.js --what special-day): the dialog shows its controls
 * 3.1-3.4 s after Time Slots is clicked, and "Reading N shows' episode lists..." stays at the
 * top of its body for another 2.3-3.7 s. When that line went, everything below it rose 25 px,
 * so a click on "+ Add special day" in those seconds landed on the Filter slots box: 202 of 300
 * real clicks made at once missed. The line now sits in the dialog's footer, beside Cancel and
 * Create Lineup, where its coming and going moves nothing a person might be pointing at.
 */
const fs = require('fs');
const path = require('path');
const { Suite } = require('./support');

const TEMPLATE = path.join(__dirname, '..', 'web', 'public', 'templates', 'time-slots-schedule-editor.html');

// The text of every element whose opening tag carries `marker` (a class or attribute), by div depth.
function blocks(html, marker) {
    const out = [];
    let from = 0;
    for (;;) {
        const at = html.indexOf(marker, from);
        if (at < 0) {
            return out;
        }
        const start = html.lastIndexOf('<div', at);
        const tags = /<div\b|<\/div>/g;
        tags.lastIndex = start;
        let depth = 0;
        let m;
        while ( (m = tags.exec(html)) !== null ) {
            depth += (m[0] === '</div>') ? -1 : 1;
            if (depth === 0) {
                out.push(html.slice(start, tags.lastIndex));
                break;
            }
        }
        from = at + marker.length;
    }
}

module.exports = async () => {
    const suite = new Suite('Time Slots: nothing moves under a click while it reads');
    const html = fs.readFileSync(TEMPLATE, 'utf8');
    const READING = 'Reading {{catalog.readCount}}';
    const bodies = blocks(html, 'class="modal-body"');
    const footers = blocks(html, 'class="modal-footer"');
    suite.check('the "Reading ... episode lists" line is not in the dialog\'s body, above its controls',
        ! bodies.some( (b) => b.includes(READING) ), `${bodies.filter( (b) => b.includes(READING) ).length} body block(s) hold it`);
    suite.check('...it is in the footer, beside Cancel and Create Lineup',
        footers.some( (f) => f.includes(READING) && f.includes('Create Lineup') ));
    return suite;
};
