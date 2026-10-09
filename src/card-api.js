const fs = require('fs');
const path = require('path');
const cards = require('./card-templates');

/*
 * The routes for generated cards (docs/blocks-spec.md, Stage 5, "Generated
 * cards"): the Cards page's templates, previews and moments, and the template
 * list the transitions editor offers. Kept out of api.js, which only mounts it.
 *
 * Anything that changes what a card should look like (a template saved, a moment
 * chosen, "render again") starts a scan in the background and answers at once:
 * rendering takes seconds to a minute a card, and the page asks again for how
 * the cards are getting on.
 */

function fontFolder() {
    return (process.platform === 'win32') ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts') : '/usr/share/fonts';
}

function fonts() {
    try {
        return fs.readdirSync(fontFolder()).filter( (f) => /\.(ttf|otf)$/i.test(f) ).sort( (a, b) => a.localeCompare(b) );
    } catch (err) {
        return [];
    }
}

module.exports = function cardRoutes(router, cardService) {
    const scanSoon = () => {
        cardService.scan().catch( (err) => console.error('Cards: scan failed', err) );
    };
    const fail = (res, err) => {
        console.error(err);
        res.status(500).send( { error: 'Something went wrong; see the server log.' } );
    };

    // For the transitions editor: each template's name and how long its cards run.
    router.get('/api/cards/templates', (req, res) => {
        res.send(cardService.templateDB.templates().map( (t) => ({
            id: t.id, name: t.name || '(unnamed)', seconds: cards.totalSeconds(t),
        }) ));
    } );

    // The Cards page: every template as the renderer reads it, the defaults for a
    // new one, the cards wanted in the next week and how each is getting on.
    router.get('/api/cards', (req, res) => {
        try {
            res.send( {
                templates: cardService.templateDB.templates().map( (t) => Object.assign(cards.normalizeTemplate(t), {
                    seconds: cards.totalSeconds(t), problems: cards.templateProblems(t) }) ),
                defaults: cards.DEFAULT_TEMPLATE,
                upcoming: cardService.upcoming(),
                fonts: fonts(),
            } );
        } catch (err) {
            fail(res, err);
        }
    } );

    router.post('/api/cards/templates', async (req, res) => {
        try {
            const draft = cards.normalizeTemplate(req.body);
            const problems = cards.templateProblems(draft);
            if (problems.length > 0) {
                return res.status(400).send( { error: problems.join(' ') } );
            }
            const saved = await cardService.templateDB.saveTemplate(draft);
            scanSoon();
            res.send( { template: saved } );
        } catch (err) {
            fail(res, err);
        }
    } );

    router.delete('/api/cards/templates/:id', async (req, res) => {
        try {
            await cardService.templateDB.deleteTemplate(req.params.id);
            res.send( { deleted: req.params.id } );
        } catch (err) {
            fail(res, err);
        }
    } );

    // A movie's moment chosen by hand (seconds from its start), or null for the picked one.
    router.post('/api/cards/moment', async (req, res) => {
        const body = req.body || {};
        const startS = body.startS;
        if ( (typeof(body.movieKey) !== 'string') || ( (startS !== null) && ( (typeof(startS) !== 'number') || ! isFinite(startS) || (startS < 0) ) ) ) {
            return res.status(400).send( { error: 'Give a movie and a moment of 0 seconds or more (or none, for the picked one).' } );
        }
        try {
            await cardService.setMoment(body.movieKey, startS);
            scanSoon();
            res.send( { upcoming: cardService.upcoming() } );
        } catch (err) {
            fail(res, err);
        }
    } );

    // Render a card again from scratch (a movie's file that can now be read, new art in Plex).
    router.post('/api/cards/rerender', async (req, res) => {
        try {
            await cardService.forget(String((req.body || {}).key || ''));
            scanSoon();
            res.send( { upcoming: cardService.upcoming() } );
        } catch (err) {
            fail(res, err);
        }
    } );

    router.post('/api/cards/scan', (req, res) => {
        scanSoon();
        res.send( { started: true } );
    } );

    router.get('/api/cards/movies', async (req, res) => {
        try {
            res.send( (await cardService.movies()).map( (m) => ({ movieKey: m.movieKey, title: m.title, year: m.year }) ) );
        } catch (err) {
            fail(res, err);
        }
    } );

    // A small preview of a template (saved or not) for one movie: a frame or a short clip.
    router.post('/api/cards/preview', async (req, res) => {
        const body = req.body || {};
        try {
            const made = await cardService.preview(body.template, String(body.movieKey || ''), (body.kind === 'clip') ? 'clip' : 'frame', body.when);
            res.send( Object.assign( {}, made, { url: '/api/cards/preview-file/' + made.file } ) );
        } catch (err) {
            console.error(err);
            res.status(400).send( { error: err.message } );
        }
    } );

    router.get('/api/cards/preview-file/:name', (req, res) => {
        const file = cardService.previewPath(req.params.name);
        if (file === null) {
            return res.status(404).send('Not found');
        }
        res.sendFile(file);
    } );

    // Whether a file for the ending or the music can be read, how long it is, and whether it has sound.
    router.post('/api/cards/probe', async (req, res) => {
        const file = String((req.body || {}).file || '');
        try {
            const info = (file === '') ? null : await cardService.probe(file);
            res.send( (info === null) ? { ok: false } : { ok: true, durationS: info.durationS, hasAudio: info.audio !== null, hasVideo: info.video !== null } );
        } catch (err) {
            fail(res, err);
        }
    } );
};
