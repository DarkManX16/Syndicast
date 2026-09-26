/*
 * Time slots and the blocks overlay count days from different places, and
 * mixing the two silently shifts everything by three days.
 *
 * A weekly slot's `time` is ms into the *epoch* week: time-slots-service.js
 * resolves it as `local % schedule.period`, and 1 January 1970 was a Thursday,
 * so slot day 0 is Thursday. That is why both slot editors list their days
 * Thursday-first rather than as anyone would write them by hand.
 *
 * Day-parts and blocks count calendar days instead - an airing's `days` are
 * 0 (Sunday) to 6, matching Date#getDay, which is what day-parts.js resolves
 * against.
 *
 * So anything comparing a slot's time against a block's airing, or drawing
 * slots onto a Sunday-first calendar, has to convert between the two. This is
 * the one place that knows the offset; test/blocks-schedule-view.js pins it
 * against time-slots-service.js's own arithmetic so the two cannot drift.
 */

const DAY = 24 * 60 * 60 * 1000;

/*
 * Indexed by slot day, so DAY_NAMES[0] is Thursday. Both slot editors read
 * their day labels from here rather than keeping their own copy.
 */
const DAY_NAMES = [ "Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday" ];

// Thursday is day 4 of a Sunday-first week.
const EPOCH_WEEKDAY = 4;

function calendarDayOf(slotDay) {
    return ( (slotDay % 7) + EPOCH_WEEKDAY ) % 7;
}

function slotDayOf(calendarDay) {
    return ( (calendarDay % 7) - EPOCH_WEEKDAY + 7 ) % 7;
}

/*
 * A weekly slot's time restated as ms into a calendar (Sunday-first) week -
 * the coordinate day-parts.js's airing spans and week positions already use.
 * The time of day is untouched; only which day it belongs to moves.
 */
function calendarWeekMs(slotTime) {
    return calendarDayOf( Math.floor(slotTime / DAY) ) * DAY + (slotTime % DAY);
}

module.exports = {
    DAY_NAMES: DAY_NAMES,
    calendarDayOf: calendarDayOf,
    slotDayOf: slotDayOf,
    calendarWeekMs: calendarWeekMs,
};
