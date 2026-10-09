/*
 * Generated cards: the routes the Cards page and the step editor use
 * (src/card-api.js), through express, with a stand-in card service.
 */
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const { Suite } = require('./support');
const cardApi = require('../src/card-api');

function call(port, method, path, body) {
    return new Promise( (resolve, reject) => {
        const data = (body === undefined) ? null : Buffer.from(JSON.stringify(body));
        const req = http.request( { host: '127.0.0.1', port, path, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch (err) { json = null; }
                resolve( { status: res.statusCode, json: json, text: text } );
            } );
        } );
        req.on('error', reject);
        if (data) {
            req.write(data);
        }
        req.end();
    } );
}

module.exports = async () => {
    const suite = new Suite('card api');
    const saved = [];
    const scans = [];
    const moments = [];
    const templates = [ { id: 'tpl_ct', name: 'Cartoon Theatre Next Time', ending: { file: 'G:/end.mp4', startS: 11.25, lengthS: 3.82 } } ];
    const service = {
        templateDB: {
            templates: () => templates,
            template: (id) => templates.find( (t) => t.id === id ) || null,
            moments: () => ({}),
            saveTemplate: async (t) => { const s = Object.assign({ id: t.id || 'tpl_new' }, t); saved.push(s); return s; },
            deleteTemplate: async (id) => { saved.push( { deleted: id } ); },
        },
        upcoming: () => [ { key: 'abc', state: 'ready', title: 'Scooby-Doo', movieKey: 'srv|1', when: 'NEXT SATURDAY · 7PM' } ],
        scan: async () => { scans.push(1); return { wanted: 1, rendered: 0, failed: 0 }; },
        setMoment: async (key, s) => { moments.push( [key, s] ); },
        forget: async () => {},
        movies: async () => [ { movieKey: 'srv|1', title: 'Scooby-Doo', year: 2002, program: {}, channel: {} } ],
        preview: async () => ({ file: 'preview-abc123.png', mode: 'footage', momentS: 2661.9, when: 'NEXT SATURDAY · 7PM' }),
        previewPath: (name) => (name === 'preview-abc123.png') ? __filename : null,
        probe: async (file) => (file === 'G:/end.mp4') ? { video: {}, audio: {}, durationS: 15.07 } : null,
    };
    const app = express();
    app.use(bodyParser.json());
    const router = express.Router();
    cardApi(router, service);
    app.use(router);
    const server = await new Promise( (resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); } );
    const port = server.address().port;
    try {
        const list = await call(port, 'GET', '/api/cards/templates');
        suite.check('the editor gets each template\'s id, name and length',
            (list.status === 200) && (list.json.length === 1) && (list.json[0].id === 'tpl_ct')
            && (list.json[0].name === 'Cartoon Theatre Next Time') && (list.json[0].seconds === 15.07), list.text);

        const page = await call(port, 'GET', '/api/cards');
        suite.check('the page gets the templates filled in, the defaults, and the cards coming up',
            (page.status === 200) && (page.json.templates[0].footageSeconds === 11.25) && (page.json.defaults.headingMain === 'CARTOON THEATRE')
            && (page.json.upcoming[0].title === 'Scooby-Doo') && Array.isArray(page.json.fonts), page.text.slice(0, 200));

        const bad = await call(port, 'POST', '/api/cards/templates', { name: '' });
        suite.check('a template with problems is refused, saying why', (bad.status === 400) && /name/.test(bad.json.error) && (saved.length === 0));
        const good = await call(port, 'POST', '/api/cards/templates', { id: 'tpl_ct', name: 'Renamed' });
        suite.check('a good template is saved, and the cards are looked at again',
            (good.status === 200) && (saved[0].name === 'Renamed') && (scans.length === 1), good.text);

        const m = await call(port, 'POST', '/api/cards/moment', { movieKey: 'srv|1', startS: 1234.5 });
        suite.check('choosing a moment for a movie is passed on, and the cards are looked at again',
            (m.status === 200) && (moments[0][0] === 'srv|1') && (moments[0][1] === 1234.5) && (scans.length === 2));
        const reset = await call(port, 'POST', '/api/cards/moment', { movieKey: 'srv|1', startS: null });
        suite.check('... and going back to the picked one', (reset.status === 200) && (moments[1][1] === null));
        const neg = await call(port, 'POST', '/api/cards/moment', { movieKey: 'srv|1', startS: -5 });
        suite.check('... a negative moment is refused', neg.status === 400);

        const pv = await call(port, 'POST', '/api/cards/preview', { template: templates[0], movieKey: 'srv|1', kind: 'frame' });
        suite.check('a preview answers with where to fetch it', (pv.status === 200) && (pv.json.url === '/api/cards/preview-file/preview-abc123.png'), pv.text);
        const file = await call(port, 'GET', '/api/cards/preview-file/preview-abc123.png');
        suite.check('... and it can be fetched', file.status === 200);
        const sneaky = await call(port, 'GET', '/api/cards/preview-file/..%2F..%2Fcard-templates.json');
        suite.check('... but nothing else can be fetched that way', sneaky.status === 404);

        const probe = await call(port, 'POST', '/api/cards/probe', { file: 'G:/end.mp4' });
        suite.check('a file for the ending or music can be checked', (probe.status === 200) && (probe.json.ok === true) && (probe.json.durationS === 15.07) && (probe.json.hasAudio === true));
        const noFile = await call(port, 'POST', '/api/cards/probe', { file: 'G:/nope.mp4' });
        suite.check('... and one that cannot be read says so', (noFile.status === 200) && (noFile.json.ok === false));

        const movies = await call(port, 'GET', '/api/cards/movies');
        suite.check('the movies to preview with, without their whole programs', (movies.json[0].title === 'Scooby-Doo') && (typeof(movies.json[0].program) === 'undefined'));
    } finally {
        server.close();
    }
    return suite;
};

if (require.main === module) {
    module.exports().then((suite) => {
        console.log(`\n${suite.count - suite.failures}/${suite.count} passed.`);
        process.exitCode = suite.failures === 0 ? 0 : 1;
    });
}
