/*
 * Which dated backup-run folders (see scripts/backup.js) to keep. Pure - no
 * filesystem access - so the caller decides when it's safe to act on the
 * plan (backup.js only calls this after a run finishes without failures).
 */

const RUN_NAME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(-INCOMPLETE)?$/;

// Local time, matching the machine's own clock the same way every other
// wall-clock-facing part of this app does (day-parts.js, time-slots-service.js).
function formatRunFolderName(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
        + `T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function parseRunFolderName(name) {
    const m = RUN_NAME.exec(name);
    if (!m) {
        return null;
    }
    const [, year, month, day, hour, minute, second, incomplete] = m;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(month) - 1) {
        // new Date() rolls an out-of-range field over into the next one
        // (month 13 becomes January) instead of failing, so a folder name
        // with an impossible date has to be caught by checking it round-trips.
        return null;
    }
    return { name, date, complete: !incomplete };
}

// keepDays: age cutoff in days. keepNewestComplete: how many of the newest
// *complete* runs survive regardless of age - an -INCOMPLETE run never
// occupies one of those slots, but still gets the ordinary age cutoff.
function planRetention(names, { now = Date.now(), keepDays = 14, keepNewestComplete = 5 } = {}) {
    const entries = names.map(parseRunFolderName).filter(Boolean);
    entries.sort((a, b) => b.date.getTime() - a.date.getTime());

    const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
    const keep = [];
    let completeSeen = 0;
    for (const entry of entries) {
        if (entry.complete && completeSeen < keepNewestComplete) {
            completeSeen++;
            keep.push(entry.name);
            continue;
        }
        if (entry.date.getTime() >= cutoff) {
            keep.push(entry.name);
        }
    }
    const keptSet = new Set(keep);
    const remove = entries.filter((e) => !keptSet.has(e.name)).map((e) => e.name);
    return { keep, remove };
}

module.exports = { formatRunFolderName, parseRunFolderName, planRetention };
