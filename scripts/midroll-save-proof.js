/*
 * Step 5e's proof (docs/blocks-spec.md, build order 5e), read-only, on a COPY of the data folder:
 * the Midroll situation and its setting change nothing saved. For every saved channel:
 *   1. it loads, and saved again is byte-for-byte what it was (ChannelDB, the way a save writes it);
 *   2. its save-time warnings are the same as blocks' (no new ones, none about midrolls);
 *   3. each day-part and block saved from the transitions editor is what blocks' editor saves;
 *   4. each context reads the same four situations as before, an empty midroll, and the default setting.
 *
 *   node scripts/midroll-save-proof.js <copy of .dizquetv-dev> <checkout of blocks without 5e>
 */
const fs = require('fs');
const path = require('path');

const [ folder, oldRoot ] = process.argv.slice(2);
if (! folder || ! oldRoot || /[\\/]\.dizquetv-dev[\\/]?$/.test(folder)) {
    console.error('usage: node scripts/midroll-save-proof.js <a COPY of .dizquetv-dev> <checkout without 5e>');
    process.exit(2);
}
const NEW = path.join(__dirname, '..');
const mod = (root, rel) => require(path.join(root, rel));
const now = { transitions: mod(NEW, 'src/transitions'), editor: mod(NEW, 'src/transitions-editor'), ChannelDB: mod(NEW, 'src/dao/channel-db') };
const before = { transitions: mod(oldRoot, 'src/transitions'), editor: mod(oldRoot, 'src/transitions-editor'), ChannelDB: mod(oldRoot, 'src/dao/channel-db') };

const warnings = (DB, json) => {
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try {
        new DB(path.join(folder, 'channels')).validateChannelJson(json.number, json);
    } finally {
        console.error = real;
    }
    return lines;
};
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
    const dir = path.join(folder, 'channels');
    const files = fs.readdirSync(dir).filter( (f) => /^\d+\.json$/.test(f) );
    const db = new now.ChannelDB(dir);
    const out = { channels: 0, sameBytes: 0, sameWarnings: 0, contexts: 0, sameEditorSave: 0, sameReading: 0, problems: [] };
    for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const n = Number(f.replace('.json', ''));
        out.channels++;
        const loaded = await db.getChannel(n);
        // 1. saved again (ChannelDB.saveChannel writes JSON.stringify(json)) is the file as it was
        if (JSON.stringify(loaded) === raw) {
            out.sameBytes++;
        } else {
            out.problems.push(`channel ${n}: saved again differs from the file`);
        }
        // 2. the same warnings as blocks gives
        const w1 = warnings(now.ChannelDB, clone(loaded));
        const w0 = warnings(before.ChannelDB, clone(loaded));
        if (JSON.stringify(w1) === JSON.stringify(w0)) {
            out.sameWarnings++;
        } else {
            out.problems.push(`channel ${n}: warnings differ: ${JSON.stringify(w1.filter( (l) => ! w0.includes(l) ))}`);
        }
        for (const kind of [ 'dayParts', 'blocks' ]) {
            for (const [ i, context ] of (loaded[kind] || []).entries()) {
                if (context == null) {
                    continue;
                }
                out.contexts++;
                // 3. saved from the editor, as blocks' editor saves it
                const a = clone(context);
                const b = clone(context);
                const had = typeof(context.transitions) !== 'undefined';
                now.editor.commit(a, now.editor.loadDraft(a), had);
                before.editor.commit(b, before.editor.loadDraft(b), had);
                if (JSON.stringify(a) === JSON.stringify(b)) {
                    out.sameEditorSave++;
                } else {
                    out.problems.push(`channel ${n} ${kind} ${i}: the editor saves it differently`);
                }
                // 4. read: the four as before, an empty midroll, the default setting
                const r1 = now.transitions.normalizeTransitions(context);
                const r0 = before.transitions.normalizeTransitions(context);
                const four = (r) => JSON.stringify( [ 'leaving', 'entering', 'betweenEpisodes', 'betweenShows' ].map( (s) => r[s] ) );
                const setting = now.transitions.normalizeMidrolls(context);
                if ( (four(r1) === four(r0)) && (r1.midroll.out.length === 0) && (r1.midroll.in.length === 0)
                    && (JSON.stringify(setting) === JSON.stringify(now.transitions.MIDROLL_DEFAULTS)) ) {
                    out.sameReading++;
                } else {
                    out.problems.push(`channel ${n} ${kind} ${i}: read differently`);
                }
            }
        }
    }
    console.log(JSON.stringify(out, null, 1));
    process.exit(out.problems.length ? 1 : 0);
})().catch( (e) => { console.error(e); process.exit(1); } );
