/*
 * When the break scanner may run, and how hard (docs/blocks-spec.md, Stage 6,
 * "The scanner, and live streams"). Pure: the service feeds it every live
 * item's pace and the whole PC's CPU every 2 s, says when its own ffmpeg is
 * running, and asks it for the mode.
 *
 *   normal  no Syndicast stream playing and the PC's CPU under 70%: one file
 *           after another.
 *   gentle  any stream playing (or the CPU at 70% or more, or just back from
 *           a pause): after each ffmpeg run, rest twice as long as it ran, and
 *           leave the drives live streams are reading alone.
 *   paused  a channel's live items below 0.99 for 10 s, or the CPU above 85% for
 *           30 s, while the scanner is working: its ffmpeg is stopped at once,
 *           it waits 10 minutes and resumes Gentle. A pause within an hour of
 *           the last one ending waits twice as long as that one did, up to 2
 *           hours.
 *   off     paused by hand, until resumed by hand.
 */

const PACE_FLOOR = 0.99;
const PACE_LOW_FOR_MS = 10 * 1000;
const CPU_GENTLE = 0.70;
const CPU_PAUSE = 0.85;
const CPU_PAUSE_FOR_MS = 30 * 1000;
const CPU_AVERAGE_MS = 10 * 1000;
const FIRST_WAIT_MS = 10 * 60 * 1000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const DOUBLE_WITHIN_MS = 60 * 60 * 1000;
const REST_FACTOR = 2;
const LOG_KEEP = 500;
const PACE_STATS_KEEP = 200;

function clockText(ms) {
    const d = new Date(ms);
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = (h < 12) ? 'am' : 'pm';
    h = h % 12;
    return `${(h === 0) ? 12 : h}:${m}${ampm}`;
}

function minutesText(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) {
        return `${min} min`;
    }
    const h = Math.floor(min / 60);
    return (min % 60 === 0) ? `${h} h` : `${h} h ${min % 60} min`;
}

function itemName(item) {
    const ch = (item.channel != null) ? `channel ${item.channel}` : 'a channel';
    return item.title ? `${ch}'s ${item.title}` : `${ch}'s item`;
}

class ScanGovernor {
    /*
     * options: { now, force } - force ('normal' or 'gentle') pins the mode a
     * stream would otherwise choose, for a proof; pauses still apply.
     */
    constructor(options = {}) {
        this.now = options.now || ( () => Date.now() );
        this.force = options.force || null;
        this.manualPaused = false;
        this.pausedUntil = 0;
        this.pauseReason = '';
        this.lastPauseAt = null;
        this.lastWaitMs = 0;
        this.resumeGentle = false;
        this.working = false;
        this.live = [];
        this.cpu = [];
        this.belowSince = new Map();
        this.paceStats = new Map();
        this.log = [];
        this.lastMode = null;
    }

    addLog(kind, text, extra = {}) {
        this.log.push(Object.assign( { at: this.now(), kind, text }, extra ));
        if (this.log.length > LOG_KEEP) {
            this.log.shift();
        }
    }

    /*
     * drive: the drive of the file being scanned. It is kept through the rests
     * between that file's runs and cleared by fileDone(): a viewer's slowdown
     * counts only while the scanner is on a file from that viewer's drive (DarkManX16,
     * Nov 12), and the pause's log entry names it.
     */
    setWorking(working, drive = null) {
        this.working = working;
        if (working) {
            this.scanningDrive = drive;
        }
    }

    setManualPaused(paused) {
        if (paused === this.manualPaused) {
            return;
        }
        this.manualPaused = paused;
        this.addLog(paused ? 'off' : 'on', paused ? 'Paused by hand' : 'Resumed by hand');
    }

    cpuAverage(windowMs) {
        const from = this.now() - windowMs;
        const recent = this.cpu.filter( (s) => s.at > from );
        if (recent.length === 0) {
            return null;
        }
        return recent.reduce( (a, s) => a + s.value, 0 ) / recent.length;
    }

    cpuHighForLong() {
        const now = this.now();
        const recent = this.cpu.filter( (s) => s.at > now - CPU_PAUSE_FOR_MS );
        const oldest = this.cpu.find( (s) => s.at <= now - CPU_PAUSE_FOR_MS + 2000 );
        return (oldest != null) && (recent.length > 0) && recent.every( (s) => s.value > CPU_PAUSE );
    }

    isPaused() {
        return this.now() < this.pausedUntil;
    }

    /*
     * extra: what the log entry keeps besides its text - for a slow item, the
     * drive it was playing from and the drive the scanner was reading, so a
     * pause on the scanner's own drive can be told from one elsewhere.
     */
    pause(reason, extra = {}) {
        const now = this.now();
        // "within the hour" of the last pause ending; from its start, a wait
        // past 80 minutes could never be followed by a doubled one.
        const wait = ( (this.lastPauseAt != null) && (now - this.pausedUntil < DOUBLE_WITHIN_MS) )
            ? Math.min(this.lastWaitMs * 2, MAX_WAIT_MS)
            : FIRST_WAIT_MS;
        this.pausedUntil = now + wait;
        this.pauseReason = reason;
        this.lastPauseAt = now;
        this.lastWaitMs = wait;
        this.resumeGentle = true;
        this.addLog('pause', `Paused for ${minutesText(wait)}: ${reason}`, extra);
    }

    /*
     * live: [{ id, channel, title, drive, pace }] (pace null until known);
     * cpu: the PC's busy fraction since the last call. Returns
     * { pauseNow: true } the moment the scanner must stop its ffmpeg.
     */
    observe( { live, cpu } ) {
        const now = this.now();
        if (typeof(cpu) === 'number') {
            this.cpu.push( { at: now, value: cpu } );
        }
        while ( (this.cpu.length > 0) && (this.cpu[0].at < now - 2 * CPU_PAUSE_FOR_MS) ) {
            this.cpu.shift();
        }
        this.live = live || [];
        /*
         * The 10 s are counted per channel, not per item: measured, a break of
         * 6-15 s bumpers each too short to fill 10 s on its own kept a
         * starved stream slow for 80 s. A low reading on any of the channel's
         * items carries the count on, a healthy one ends it, and the seconds
         * at an item's start with no reading yet leave it as it is.
         *
         * Only an item on the drive of the file being scanned counts (DarkManX16, Nov
         * 12): on 18000's first day on Very Low disk priority, 14 pauses came
         * from viewers slow on other drives and none from the scanner's own,
         * and viewers on its drive were no slower than with it idle. An item
         * on another drive ends the count, since the scanner is not reading it.
         */
        const channels = new Map();
        for (const item of this.live) {
            const c = channels.get(item.channel) || { low: null, healthy: false };
            channels.set(item.channel, c);
            // held back by its reader (a slow viewer, or none left): its pace
            // says nothing about what the scanner does to it
            if ( (item.held === true) || (item.pace == null) ) {
                continue;
            }
            if ( (this.scanningDrive == null) || (item.drive !== this.scanningDrive) ) {
                c.healthy = true;
                continue;
            }
            if (item.pace < PACE_FLOOR) {
                if ( (c.low === null) || (item.pace < c.low.pace) ) {
                    c.low = item;
                }
            } else {
                c.healthy = true;
            }
        }
        for (const [channel, c] of channels) {
            if (c.low !== null) {
                const run = this.belowSince.get(channel);
                this.belowSince.set(channel, { since: run ? run.since : now, item: c.low });
            } else if (c.healthy) {
                this.belowSince.delete(channel);
            }
        }
        for (const channel of Array.from(this.belowSince.keys())) {
            if (! channels.has(channel)) {
                this.belowSince.delete(channel);
            }
        }
        for (const item of this.live) {
            if ( (item.held !== true) && (item.pace != null) ) {
                let s = this.paceStats.get(item.id);
                if (s == null) {
                    s = { channel: item.channel, title: item.title, scanning: { n: 0, sum: 0, min: null }, idle: { n: 0, sum: 0, min: null } };
                    this.paceStats.set(item.id, s);
                }
                const b = this.working ? s.scanning : s.idle;
                b.n++;
                b.sum += item.pace;
                b.min = (b.min === null) ? item.pace : Math.min(b.min, item.pace);
            }
        }
        while (this.paceStats.size > PACE_STATS_KEEP) {
            this.paceStats.delete(this.paceStats.keys().next().value);
        }

        let pauseNow = false;
        if (this.working && ! this.manualPaused && ! this.isPaused()) {
            const slow = Array.from(this.belowSince.values()).find( (run) => now - run.since >= PACE_LOW_FOR_MS );
            if (slow != null) {
                this.pause(`${itemName(slow.item)} fell to ${slow.item.pace.toFixed(3)}`, { drive: slow.item.drive || null, scanningDrive: this.scanningDrive || null });
                pauseNow = true;
            } else if (this.cpuHighForLong()) {
                this.pause(`the PC's CPU stayed above ${Math.round(CPU_PAUSE * 100)}% for ${CPU_PAUSE_FOR_MS / 1000} s`, { scanningDrive: this.scanningDrive || null });
                pauseNow = true;
            }
        }
        this.noteMode();
        return { pauseNow };
    }

    noteMode() {
        const mode = this.mode();
        if (mode !== this.lastMode) {
            if ( (this.lastMode === 'paused') && (mode !== 'off') ) {
                this.addLog('resume', `Resumed ${mode === 'gentle' ? 'Gentle' : 'Normal'} after the pause`);
            } else if ( (mode === 'normal') || (mode === 'gentle') ) {
                this.addLog('mode', this.reason());
            }
            this.lastMode = mode;
        }
    }

    // The scanner finished a file, so a pause's "resume Gentle" has done its job.
    fileDone() {
        this.scanningDrive = null;
        if (! this.isPaused()) {
            this.resumeGentle = false;
        }
    }

    mode() {
        if (this.manualPaused) {
            return 'off';
        }
        if (this.isPaused()) {
            return 'paused';
        }
        if (this.resumeGentle) {
            return 'gentle';
        }
        if (this.force === 'normal' || this.force === 'gentle') {
            return this.force;
        }
        if (this.live.length > 0) {
            return 'gentle';
        }
        const cpu = this.cpuAverage(CPU_AVERAGE_MS);
        if ( (cpu !== null) && (cpu >= CPU_GENTLE) ) {
            return 'gentle';
        }
        return 'normal';
    }

    reason() {
        const mode = this.mode();
        const n = this.live.length;
        const cpu = this.cpuAverage(CPU_AVERAGE_MS);
        const cpuText = (cpu === null) ? '' : `CPU ${Math.round(cpu * 100)}%`;
        const forced = this.force ? ' (forced)' : '';
        if (mode === 'off') {
            return 'Paused by hand';
        }
        if (mode === 'paused') {
            return `Paused until ${clockText(this.pausedUntil)}: ${this.pauseReason}`;
        }
        if (mode === 'gentle') {
            if (this.force === 'gentle') {
                return `Gentle${forced}: ${n} stream${n === 1 ? '' : 's'} playing`;
            }
            if (n > 0) {
                return `Gentle: ${n} stream${n === 1 ? '' : 's'} playing`;
            }
            if (this.resumeGentle) {
                return 'Gentle: back from a pause';
            }
            return `Gentle: the PC's ${cpuText}`;
        }
        if (n > 0) {
            return `Normal${forced}: ${n} stream${n === 1 ? '' : 's'} playing`;
        }
        return `Normal: nothing playing${cpuText ? ', ' + cpuText : ''}`;
    }

    // How long to rest after an ffmpeg run that took runMs.
    restMs(runMs) {
        return (this.mode() === 'gentle') ? REST_FACTOR * runMs : 0;
    }

    busyDrives() {
        return new Set(this.live.map( (item) => item.drive ).filter( (d) => d != null ));
    }

    // Each live item's pace while the scanner's ffmpeg ran, against while it didn't.
    paceReport() {
        const avg = (b) => (b.n > 0) ? b.sum / b.n : null;
        return Array.from(this.paceStats.entries()).map( ([id, s]) => ({
            id, channel: s.channel, title: s.title,
            scanning: { samples: s.scanning.n, average: avg(s.scanning), lowest: s.scanning.min },
            idle: { samples: s.idle.n, average: avg(s.idle), lowest: s.idle.min },
        }) );
    }
}

module.exports = {
    ScanGovernor, clockText,
    constants: {
        PACE_FLOOR, PACE_LOW_FOR_MS, CPU_GENTLE, CPU_PAUSE, CPU_PAUSE_FOR_MS, CPU_AVERAGE_MS,
        FIRST_WAIT_MS, MAX_WAIT_MS, DOUBLE_WITHIN_MS, REST_FACTOR,
    },
};
