/*
 * The break scanner's status, the Midrolls switch, its Pause / Resume switch and its skipped drives
 * (docs/blocks-spec.md, Stage 6, "The scanner, and live streams").
 */
module.exports = function breakScanRoutes(router, breakScanService) {
    router.get('/api/breaks/scanner', (req, res) => {
        res.send(breakScanService.status());
    } );

    // { midrolls: true | false }, { paused: true | false } and/or { skipDrives: ['E:'] }; [] scans
    // every drive again. A body with none of them resumes, as before.
    router.put('/api/breaks/scanner', async (req, res) => {
        const body = req.body || {};
        if ( (body.skipDrives !== undefined) && ! Array.isArray(body.skipDrives) ) {
            res.status(400).send( { error: 'skipDrives must be a list of drives, like ["E:"].' } );
            return;
        }
        if ( (body.midrolls !== undefined) && (typeof(body.midrolls) !== 'boolean') ) {
            res.status(400).send( { error: 'midrolls must be true or false.' } );
            return;
        }
        try {
            if (body.midrolls !== undefined) {
                await breakScanService.setMidrolls(body.midrolls);
            }
            if (body.skipDrives !== undefined) {
                await breakScanService.setSkipDrives(body.skipDrives);
            }
            if ( (body.paused !== undefined) || ( (body.skipDrives === undefined) && (body.midrolls === undefined) ) ) {
                await breakScanService.setPaused(body.paused === true);
            }
            res.send(breakScanService.status());
        } catch (err) {
            console.error(err);
            res.status(500).send( { error: 'Something went wrong; see the server log.' } );
        }
    } );
};
