/*
 * The page's side of src/relay-worker.js: a swap's re-lays run in a Web Worker
 * made from this page's own bundle (web/app.js), so the page stays responsive
 * while the Time Slots generator runs. Each session - a swap or insert dialog,
 * an undo, a delete - gets a worker of its own, started when the session
 * begins and ended when it closes: one worker kept for every dialog got slower
 * with each (a re-lay took 0.4 s in a fresh one, 7 s after a few dialogs), and
 * ending a worker frees all it held at once. Where a worker can't be made the
 * same handler runs in the page: a swap still works, the page is only busier.
 *
 * begin(session), open(session, inputs, current), call(msg) -> Promise of the
 * handler's answer (src/relay-worker.js lists them); a 'close' ends the worker.
 */
const relayWorker = require('../../src/relay-worker');

module.exports = function () {
    let failed = false;
    let inPage = null;
    let workers = new Map();
    let nextId = 1;

    let local = () => {
        if (inPage === null) {
            const timeSlotsService = require('../../src/services/time-slots-service');
            inPage = relayWorker.handler({
                generate: (a) => timeSlotsService(a.pool, a.schedule, a.history, a.pins, a.carry),
                getShowData: require('../../src/services/get-show-data')(),
            });
        }
        return inPage;
    };
    let end = (session) => {
        let w = workers.get(session);
        if (typeof(w) !== 'undefined') {
            workers.delete(session);
            w.worker.terminate();
            w.waiting.forEach( (x) => x.reject(new Error('The background re-lay was closed.')) );
        }
    };
    // The session's worker, started if it hasn't been; null where workers can't run.
    let begin = (session) => {
        if (workers.has(session)) {
            return workers.get(session);
        }
        if (failed || (typeof(Worker) !== 'function')) {
            return null;
        }
        let w;
        try {
            w = { worker: new Worker('bundle.js'), waiting: new Map() };
        } catch (err) {
            console.error('Could not start the re-lay worker; re-lays run in the page', err);
            failed = true;
            return null;
        }
        w.worker.onmessage = (e) => {
            let x = w.waiting.get(e.data.id);
            if (typeof(x) !== 'undefined') {
                w.waiting.delete(e.data.id);
                if (e.data.ok) {
                    x.resolve(e.data.value);
                } else {
                    x.reject(new Error(e.data.error));
                }
            }
        };
        // A worker that dies takes its session with it: what was waiting is told,
        // and later sessions run in the page.
        w.worker.onerror = (e) => {
            console.error('The re-lay worker stopped; re-lays run in the page from now on', e);
            failed = true;
            w.waiting.forEach( (x) => x.reject(new Error('The background re-lay stopped. Close this and try again.')) );
            w.waiting.clear();
            workers.delete(session);
            w.worker.terminate();
        };
        workers.set(session, w);
        return w;
    };
    let call = (msg) => {
        if ( (msg.type === 'close') && workers.has(msg.session) ) {
            end(msg.session);
            return Promise.resolve({ closed: msg.session });
        }
        let w = begin(msg.session);
        if (w === null) {
            return local()(msg);
        }
        return new Promise( (resolve, reject) => {
            let id = nextId++;
            w.waiting.set(id, { resolve, reject });
            w.worker.postMessage({ id, msg });
        } );
    };
    let pause = () => new Promise( (resolve) => setTimeout(resolve, 0) );

    return {
        begin: (session) => { begin(session); },
        call: call,
        /*
         * Opens a session with a plan's inputs and the lineup as it is, handed over
         * in slices with a pause between: copied in one message, channel 2's pool
         * and lineup held the page still for 2.3 s.
         */
        open: async (session, inputs, current) => {
            await call({ type: 'open', session, inputs: Object.assign({}, inputs, { pool: [] }), current: { programs: [], startTime: current.startTime } });
            for (let part of relayWorker.slices(inputs.pool, 2000)) {
                await pause();
                await call({ type: 'add', session, part: 'pool', items: part });
            }
            for (let part of relayWorker.slices(current.programs, 4000)) {
                await pause();
                await call({ type: 'add', session, part: 'current', items: part });
            }
        },
    };
};
