/*
 * The break scanner's status and its Pause / Resume switch
 * (docs/blocks-spec.md, Stage 6, "The scanner, and live streams").
 */
module.exports = function breakScanRoutes(router, breakScanService) {
    router.get('/api/breaks/scanner', (req, res) => {
        res.send(breakScanService.status());
    } );

    // { paused: true | false }
    router.put('/api/breaks/scanner', async (req, res) => {
        try {
            await breakScanService.setPaused( (req.body || {}).paused === true );
            res.send(breakScanService.status());
        } catch (err) {
            console.error(err);
            res.status(500).send( { error: 'Something went wrong; see the server log.' } );
        }
    } );
};
