# Special Days Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ron gives a date its own Time Slots - shows, custom shows and picked movies, at set times or back to back on the next :00 or :30 - and optionally a block for the whole day, for channel 1's Toonami marathon on Fri Jan 1, 2027 6:00am to Sat Jan 2 6:00am and for later Christmas, Halloween and movie days. The day survives regenerations until it has aired, advances the regular show positions or leaves them alone as he chooses, lets the shows it displaces carry on as after a Swap, shows exactly beforehand in Preview, the Schedule tab and the guide, and changes nothing on any other date.

**Architecture:** A special day lives on the Time Slots schedule (`scheduleBackup.specialDays`). One pure module, `src/special-days.js`, decides which day covers a moment, its instants, the back to back rounding and the tag on Keep-apart keys and labels. The generator lays a day out in place of the regular slots for its hours. `slotProgress.slotAt` and `planProgress` learn the day's rows and its own positions. `resolveContext` checks special days before block airings. The editor reaches the same module through browserify, as it does `src/pins.js` and `src/episode-start.js`.

**Tech Stack:** Node, AngularJS 1 bundled by browserify, express, the repo's `test/support.js` Suite. No new dependencies.

**Spec:** NOTES.md, Known issues, "Special days" (agreed Oct 29, 2026, with Ron's seven decisions and the design's own choices listed at its end). Read it before any task; this plan argues from it and does not restate its reasons. Also "Per-position stored progress", "Episode start" and "Swaps, inserts and Flex that keeps time" there, and docs/blocks-spec.md's Resolution rules and Stage 5.

**Models:** steps 1-4 and 7 are the scheduling core, stored progress and the Blocks resolver: Opus 5.5 end to end (Model guide, "Work that stays on Opus 5 end to end"). Steps 5, 6 and 8 are editor work: Sonnet 5.5 · High. Step 9 is Opus 5.5.

**Brought up to date Oct 30, 2026**, on `blocks` at feea764: hand edits are kept rows (`program.kept`, `src/kept-rows.js`), not pins, and reach the generator through `keptRows.keptAhead` in the list `pins` used; Delete takes an episode out at once (`keptRows.deleteRow`); the first open keeps old pins silently (`ensureHandEditsKept`); and the Rules' "Keep it simple" and "Workflows that must keep working" apply to every step below.

**Order and stops.** Steps run in order, 1 to 9, with **step 8 (holiday rows) right after the New Year's checkpoint (step 7), so Ron's Christmas Eve 2026 marathon is ready before Dec 24**. After each step's proof the work **stops**: the proof goes to Ron, and the next step starts only on his OK.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start. Server-code changes reach 18000 only when Ron restarts it; a merge into `blocks` updates its editor bundle on the next request.
- Code only in the worktree `C:\Projects\dizquetv-worktrees\special-days`, branch `special-days` (from `blocks` once `special-days-design` is merged). `node_modules` is a junction to the main checkout's (`mklink /J`). Never `npm install` in the worktree; a needed dependency goes into the main checkout. None is planned.
- Test only on copies of `.dizquetv-dev`: `C:\Projects\dizquetv-worktrees\special-days-proof` (channels, custom shows, filler, `show-aliases.json`) and `special-days-data` (a full data folder for the preview, HDHomeRun discovery off, `xmltv-settings.json`'s `file` made absolute). Before a step's proof is reported, diff `.dizquetv-dev/channels`, `custom-shows`, `filler` and `show-aliases.json` against the copy, re-copy if they differ, re-run, and state the snapshot time.
- Plex is read only (GET, token as a header, never printed). Catalog snapshots carry the token in icon URLs: they stay beside the copies and are never committed.
- **Additive:** a schedule with no `specialDays`, or only aired ones, generates program for program what `blocks` generates; `resolveContext` answers by reference what it answers now; a channel without a Time Slots schedule is untouched.
- Copy shown to Ron is plain English, as in the spec's examples; docs and code never name other playout programs.
- `npm test` passes at the end of every task. Record the count at the start of step 1.
- Commit messages: `Special days: <what changed>`, ending with the session's `Co-Authored-By` line. Each step is its own commit; Ron says when the branch merges.
- Live checks: a preview server started by hand from the worktree (`node index.js -p 18210 -d C:/Projects/dizquetv-worktrees/special-days-data --unlock`, Bash background), restarted after any server-code change; after any `npm run build`, reload the tab and confirm the served bundle holds the change - a hash-only navigate keeps the old bundle.
- Clock-shifted checks (step 7) use the preload and bundle proxy recorded for the swap-pin-choices check: scratchpad scripts, never in the repo.
- **The workflow checklist** (NOTES.md, Rules, "Workflows that must keep working") runs, whole, before a step merges whenever the step changes the editor, its templates, `style.css`, or anything the page bundles from `src/` - `slot-progress.js`, `episode-start.js`, `show-orderers.js` (through `createPositions`), `day-parts.js`, `kept-rows.js`, `pins.js` and the new `special-days.js` among them, so in practice every step but 7 and 9: `node scripts/editor-workflows.js --url http://localhost:18210 --channel 3` on a preview of a fresh copy, then a look at the page itself. The step's report says what each workflow did. Never `preview_start` from the worktree.
- **Keep it simple.** Anything shown to Ron is at most one short line per change, and a change shows in the list itself rather than being described. No message he didn't ask for.
- **Kept rows, not pins.** Read "kept row" wherever an older note says "pin"; the editor's refusals go through `keptRows.whyNot`, its one-liners follow `keptRows.sayKept`.

## Review Focus

- **The window's edges against the generator's own boundaries** - a regular slot running into 6:00am must stop there (its `remaining` cut at the day's start), and a slot boundary exactly at the start must not air a zero-length slot. Test in Task 2.
- **Keep-apart labels read by `placeOf`** - an airing tagged `@sd_…` must never become a regular position's place, labelled lineup or not. Test in Task 3.
- **A day that ends while the generator is running late from it** - pin rule 3's `late` logic, reached from a day's end rather than a pin. Test in Task 2.
- **`resolveContext` identity** - the day must return the block object itself, or `assemble`'s `from === to` treats every break inside the day as a boundary and plays Toonami's sign-on 47 times. Test in Task 4.
- **The fall-back night inside a day** (Nov 7, 2027) and the spring gap (Mar 14, 2027). Test in Task 1.
- **A row's picked program from the Plex library** that is in no pool - the row carries it; it must survive a re-lay, a save and a reload. Test in Tasks 2 and 5.
- **A kept row inside a day's window** (a swap made before the day was added) - it stays where it sits and the day goes round it; `keptRows.clearWrong` and the silent first open must never take a special day's airings for hand edits (they carry `specialDay`, no `kept`). Test in Tasks 2 and 5.
- **The ripple into a day** - a swap elsewhere moving a show's later airings along reaches an Advance day's rows of that show, never a Keep-apart day's or a This item row. Test in Task 3.

---

## Step 1 - The rules, pure (nothing calls them yet)

### Task 1: `src/special-days.js`, and `slotAt` knows a special day

**Files:**
- Create: `src/special-days.js`, `test/special-days.js` (add to `test/run.js`)
- Modify: `src/slot-progress.js` (`slotFinder`, `slotAt`), `src/dao/channel-db.js` (`warnAboutSpecialDays`, warns and rewrites nothing, as `warnAboutBlocks`)

**Interfaces:**
- `windowOf(day) -> { from: ms, to: ms }` - local dates and clock times to instants, each at its own offset.
- `dayAt(schedule, instant) -> day | null` - the special day covering an instant, ignoring days that are not well formed.
- `ahead(schedule, now) -> day[]` - days whose end is after `now`, in order; `aired(day, now)`.
- `rowTimes(day) -> [{ row, at: ms }]` - Set times only: each row's instant.
- `nextHalfHour(t) -> ms` - the first local :00 or :30 at or after `t`, `t` within `SLACK` past one counting as on it, in real time across a clock change.
- `problems(schedule, blocks) -> [{ dayId, text }]` - overlaps, end not after start, longer than a week, a Set times day whose first row isn't at its start, two rows at one time, a block that no longer exists, a This item row with no program.
- `tag(dayId)`, `taggedKey(key, dayId)`, `tagOf(labelOrKey)` - the Keep-apart tag on position keys and labels.
- `fillFromBlock({ block, schedule }) -> rows` - the slots inside the block's airings, once, in the order they air through the calendar week (for Toonami: Mon, Tue, Wed, Fri), each with its show, order and seasons; Set times rows get times repeating at their own lengths to fill the day (`fillTimes(day, rows)`).
- `slotProgress.slotAt(schedule, instant)` - inside a Set times day, the day's row covering the instant, marked `special: dayId`; inside a Back to back day, `{ special: dayId, row: null }` (only the lineup knows its rows' times); outside, as now.

- [ ] **Step 1: Write the failing tests** in `test/special-days.js`, the machine's zone (America/Chicago), clocks frozen:
  - `New Year's window: Fri Jan 1, 2027 12:00Z to Sat Jan 2 12:00Z`.
  - `dayAt: the window's first ms is the day's, its end is not`; `an aired day still answers by instant`; `two days never both answer` (an overlapping pair is a `problems` entry, and `dayAt` takes the first declared, like blocks).
  - `nextHalfHour`: 6:47:00 to 7:00:00; 8:35:00 to 9:00:00; 7:00:05 stays 7:00:05; 7:00:10.5 goes to 7:30:00; on Nov 7, 2027, 1:47am CDT goes to 1:00am CST (07:00Z), the next :00 in real time, since the clock falls back at 2:00 CDT; on Mar 14, 2027, 1:47am CST goes to 3:00am CDT.
  - `rowTimes`: a row at 2:30am on Mar 14, 2027 is a `problems` entry ("2:30am doesn't happen that night"); on Nov 7 a row at 1:30am resolves to its first occurrence.
  - `problems`: each case above, by its text.
  - `fillFromBlock` against a fixture copy of channel 1's Toonami block and its slots: 16 rows, Ronin Warriors first, Batman/New Batman Adventures last.
  - `slotAt`: Jan 1 3:10pm in a Set times fixture day is its row; outside the day, the regular slot, deep-equal to `blocks`' answer.
- [ ] **Step 2:** run `test/special-days.js` - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy** (`scripts/special-days-check.js`, new, read-only: `--data <copy> --channel 1 --day <day.json>` prints the window, the displaced airings and `problems`):
  - Channel 1's New Year's day built by `fillFromBlock` from the real Toonami block: the 16 rows in the measured order.
  - The window over the saved lineup: 62 airings of 50 shows displaced, Waynehead first and The Smurfs (5:45am) last, as measured on Oct 28.
  - `slotAt` over every airing of channels 1-3 for 300 days, with no special day: identical to `blocks`.
  - The workflow checklist on a preview of a fresh copy (`slot-progress.js` is bundled), all workflows passing.
- [ ] **Step 6:** Commit `Special days: the rules, and slotAt knows a special day`. **Stop** and report.

## Step 2 - The generator lays out a special day

### Task 2: Both layouts and both modes in `time-slots-service.js`; `progress-check --special`

**Files:**
- Modify: `src/services/time-slots-service.js`, `src/services/show-orderers.js` (`createPositions` keyed positions for tagged rows; `positions.seekAt` for an Advance day's jump), `scripts/progress-check.js`
- Create: `test/special-days-generator.js` (add to `test/run.js`)

**Interfaces:**
- The generator reads `schedule.specialDays` (already sent with the schedule). For each day `ahead` of now: the regular slot in progress at the day's start ends there (`remaining` cut); inside the day:
  - **Set times:** rows are slots at `rowTimes`, filled by the existing slot code (fit, pad, slide, lateness).
  - **Back to back:** rows in order from the start; each starts at `nextHalfHour` of the previous row's end (a program still on at the start finishing first); a row places its first item, then more of its own while each ends by the next :00/:30; Flex to that :00/:30; the list starts again from the top when it runs out; a row whose start is at or after the end doesn't air.
  - **The end:** a program running past it - the regular schedule runs late from its end exactly as after a `late` pin, until one starts on time.
  - **Positions:** Advance rows use the regular position for their show, mode and seasons; Keep-apart rows a position keyed `taggedKey(key, dayId)`; a This item row places `row.item.program` (a copy, no `slotPosition`, never moving a position); a holiday row is left to step 8 (a `problems` entry until then).
  - Every airing inside the day carries `specialDay: dayId`; Keep-apart labels carry the tag.
  - Kept rows inside a day (from `keptRows.keptAhead`, in the list `pins` used) stay where they sit, as the generator places any kept row; in Back to back the next row starts at `nextHalfHour` after one. A Set times row is placed at its instant through the same one-off-slot path a row kept in time uses.
- `progress-check --special <day.json>` (repeatable), `--special-from-block "<block name>"`, and `--timetable <dayId>` printing every airing of the day with start, end and Flex after, then the regular schedule's first hour after it and when it is back on time.

- [ ] **Step 1: Write the failing tests** (fixtures as `test/pins-generator.js` builds them: a weekly schedule of half-hour Play Next slots, 22:00 and 11:00 episodes, custom shows of movies of 47:00 and 95:00, pad 5 minutes):
  - `no special days: the same lineup` - absent, `[]` and only aired days, deep-equal.
  - `Set times: the day's rows replace the regular slots for its hours, and nothing outside moves`.
  - `Back to back: 47:00 at 6:00, next row 7:00; 95:00 at 7:00, next row 9:00; no Flex longer than 30:00`.
  - `Back to back: two 11:00 halves share a half hour; three 7:00 shorts and a fourth share one`.
  - `Back to back: a program ending 5 s past the half hour - the next row starts at once`.
  - `Back to back: the rows run out - the list starts again, each show at its next episode`.
  - `the last row runs 14:09 past the end - the regular slots run late and are back on time by the next slot that can start on time; nothing turns to Flex at a full day's lateness`.
  - `a program still on at the start finishes; the first row starts at its end (Set times) or the next half hour (Back to back)`.
  - `Advance: a row continues the regular position, and the regular slot after the day picks up where the day left it`.
  - `Keep apart: the day's rows play from the tagged position, the regular position is untouched, and the displaced regular episode airs at its show's next slot`.
  - `This item: the picked movie airs, carries no label, and the custom show's rotation is where it was`.
  - `every airing inside the day carries specialDay; none outside does`.
  - `a Repeat whose source occurrence falls inside the day airs a Rerun of its show`.
  - `a kept swap inside a Back to back day: stays where it sits, the next row at the next half hour after it`.
  - `a day's airings carry no kept mark, and keptRows.clearWrong and firstOpen leave them alone`.
  - `the fall-back night inside a day: each Set times row airs once`.
- [ ] **Step 2:** run the file - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy**, a fresh catalog snapshot beside it, regenerated at the time of the run:
  - **Additive:** channels 1-3 with no special day, at now, Sat Dec 19 noon and Thu Dec 31 noon, against the `blocks` checkout's `progress-check --save`: 0 programs differ.
  - **New Year's, Back to back, Advance**: the 16 Toonami rows, plus two Cartoon Theatre Movies rows picked as This item - the 46-minute and a 95-minute-or-longer film - placed after the second pass's Monday and Wednesday shows. The timetable: every row on a :00 or :30, no Flex stretch of 30 minutes or more, where the day's last item ends and when the regular schedule is back on time. X-Men: Evolution and Sailor Moon's episodes in the day and their next regular airings after it (expected for three full passes: S2E3-5, then S2E6 Mon Jan 4; S1E26-28, then S1E29 - fewer passes with the movies in, and the proof says how many). I Am Weasel S4E5 Mon Jan 4 2:30pm.
  - **The same day, Keep apart:** X-Men S2E3 and Sailor Moon S1E26 on Mon Jan 4; each marathon show starting at its range's first episode.
  - **The same day, Set times** (the 16 rows filled three times): every row at its time; the movies sliding over, and how late the rows after them run.
  - **Every other date:** over 300 days, every airing outside the window in the same slot with the same show and the same time; episode differences only for the 50 displaced shows and the marathon's shows, counted by show.
  - **Twice in a row:** each result regenerated from itself, before the day (now, Dec 31 noon): identical airing for airing to the end.
  - The workflow checklist on a preview of a fresh copy (`show-orderers.js` is bundled), all passing.
- [ ] **Step 6:** Commit `Special days: the generator lays out a special day`. **Stop** and report.

## Step 3 - Stored progress and episode starts on a special day

### Task 3: `planProgress`, `placeOf` and the starts

**Files:**
- Modify: `src/slot-progress.js` (`positionKey`/`parseLabel`/`placeOf`/`planProgress`/`startRecord`), `src/episode-start.js` (`plan`, `describe`, `firstAiring`: rows of a special day; regular rows' "Next … when" skipping a day's window), `web/directives/time-slots-schedule-editor.js` (only to pass the day's starts to `planProgress`; no UI yet), `scripts/progress-check.js` (`--start` on a day's row)
- Test: `test/slot-progress.js`, `test/episode-start.js`

**Interfaces:**
- `placeOf` returns a tagged key for a tagged label, never a regular one; `readPlaces` keeps tagged places apart.
- `planProgress` plans tagged positions too: rule 2 (first airing on air or ahead) reads tagged airings; before the day begins, a row's saved `start` is the place (Keep apart) or a jump at the day's start (Advance, `seekAt`); otherwise the range's first episode (decision 2). Records are saved under tagged keys and dropped once the day has ended.
- A row's `start` is saved on the row and kept until the day begins; Episode start's one-time `starts` for regular rows are unchanged.

- [ ] **Step 1: Write the failing tests:** `a tagged airing is never a regular place, labelled or not`; `Keep apart, before the day: the place is the row's start, else the first episode`; `Keep apart, during the day: the place is the first tagged airing ahead`; `Advance: a row's start is a jump at the day's start, and the regular slot after the day carries on from the day`; `an Advance jump spent during the day isn't applied again`; `tagged records go once the day has ended`; `regular rows' Next skips a slot the day replaces` (I Am Weasel: "Next: S4E5 · Mon Jan 4, 2:30pm" when asked on Jan 1 at 4pm).
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy:** the New Year's day from step 2, both modes, regenerated with `--at` at now, Dec 31 noon, Jan 1 6:00am, Jan 1 3:10pm (during, X-Men on air - the carry) and Jan 2 noon (after): every regular position continues exactly from its last airing, every tagged position from its last tagged airing, and the day itself is the same from run to run until it begins. Advance with a jump of X-Men to S1E1: the day airs S1E1-3, Mon Jan 4 airs S1E4. A day whose rows are changed between runs: only the changed rows' positions move.
  - The workflow checklist on a preview of a fresh copy, all passing.
- [ ] **Step 6:** Commit `Special days: stored progress and episode starts`. **Stop** and report.

## Step 4 - The block for the day

### Task 4: `resolveContext` checks special days first

**Files:**
- Modify: `src/day-parts.js` (`resolveContext`, `hasOverlay`, `weeklySegments` given a reference week holding a day), `src/transitions-editor.js` (`previewBreaks` unaffected beyond the resolver; check), `scripts/transitions-plan-day.js` (`--at <date>`)
- Test: `test/blocks-acceptance.js` (stage rows tagged `row('special', …)`), `test/blocks-guide.js`, `test/transitions.js`

**Interfaces:**
- `resolveContext(channel, instant)`: inside a special day naming a block that exists, that block object; otherwise as now. Reads `channel.scheduleBackup.specialDays`; a channel with none takes exactly today's path.
- `hasOverlay` is true for a channel whose only overlay is a special day's block.

- [ ] **Step 1: Write the failing tests:** `inside the day, Toonami - the same object as channel.blocks[0]`; `a regular Toonami airing inside the day is the same context: no boundary at 3:00pm`; `the break before the day's first row: boundary, entering Toonami`; `breaks inside: betweenShows or betweenEpisodes in Toonami, never a boundary`; `the break after the last item, which started inside: boundary, leaving Toonami, entering CN City (Day)`; `a day with no block: the overlay as it was`; `a day naming a deleted block: as it was`; `an aired day changes nothing`; `guide names: a long Flex inside the day takes the block's guide name`.
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy**, the New Year's lineup from step 3: `transitions-plan-day.js --at 2027-01-01` walks every break from Thu Dec 31 6:00pm to Sat Jan 2 noon with the real lists: the break before the first row plays Toonami's 3 + 2 entering steps; every break inside is Toonami's, with its mix; no step from Cartoon Cartoon Fridays, Toonami Midnight Run or the day-parts plays inside; the break after the day plays Toonami's 2 leaving steps then CN City (Day)'s entering ones. Minute by minute from Sun Dec 27 to Sat Jan 9, `resolveContext` equals `blocks`' answer everywhere outside the window. The guide, built by `getChannelPrograms` and the real XMLTV writer on the copy for Jan 1: the marathon's programs at the lineup's times, and `blocks`' guide everywhere else.
  - The workflow checklist on a preview of a fresh copy (`day-parts.js` is bundled), all passing.
- [ ] **Step 6:** Commit `Special days: the block for the day`. **Stop** and report.

## Step 5 - The Time Slots dialog's Special days

### Task 5: List, editor, rows, This item, Fill from a block, Create Lineup

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js`, `web/public/templates/time-slots-schedule-editor.html`, `web/directives/airing-swap.js` (its picker, reused for This item), `web/directives/channel-config.js` (Programming tab: Swap, Insert after, Delete and a drag into, out of or inside a day refused), `src/kept-rows.js` (`whyNot` names the day; `sayKept` for kept rows inside a window), `web/public/css` as needed, `scripts/editor-workflows.js` (a `special-day` workflow: add a day, Fill from a block, a This item movie, Preview this day, Create Lineup, Update Channel, and a Delete inside the day refused)
- Test: `test/kept-rows.js` (`whyNot`, `sayKept`), `test/kept-editor.js` (Delete refused inside a day), `test/episode-start.js` (rows' Next lines)

**What Ron sees** (Keep it simple: nothing else): a **Special days** section above the slots, one line per day - "New Year's Toonami Marathon · Fri Jan 1, 6:00am – Sat 6:00am · Toonami" - with **Edit**, **Copy** and **Delete**; an aired day greyed. The day's editor: name, start and end, Block for the day, Advance or Keep apart, Set times or Back to back, the rows (show, order, seasons, a time for Set times, and Episode start's **Next: … · when** with **change**), **Add row**, **This item…** (the Swap picker: a custom show's list, a show's catalog, one item from the Plex library), **Fill from a block…** and **Preview this day**. A problem is one short line at its field and blocks Create Lineup. Kept rows inside the window get one line, as `sayKept` says it ("Your 1 swap on Jan 1 stays where it is."), and only when there are some. Inside a day, the list's Swap, Insert after, Delete and drag answer one line: "Change this in Time Slots, New Year's Toonami Marathon." Create Lineup and Update Channel save the day with the schedule; Cancel drops it.

- [ ] **Step 1: Write the failing tests** for the pure parts: `whyNot` inside a day ("Change this in Time Slots, New Year's Toonami Marathon.") for Swap, Insert after, Delete and a drag; Next lines for a Keep-apart row ("Next: S1E1 · Fri Jan 1, 6:00am") and an Advance jump ("Jumps to S1E1 on Fri Jan 1; your strip carries on from wherever the day leaves it").
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement; `npm run build`.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the preview** (port 18210, `special-days-data`): build step 2's New Year's day through the dialog - Fill from Toonami, two This item movies, Back to back, Advance - Create Lineup, Update Channel. The saved `channels/1.json` on the copy equals `progress-check`'s output for the same day at the same moment, program for program (the carry aside). A movie picked from the Plex library survives Update Channel, a reload and a second Create Lineup. Cancel leaves the file untouched. Swap on a marathon airing gives the refusal. The workflow checklist, all nine plus `special-day`, on a fresh copy; then a look at the dialog: no line Ron didn't ask for. Screenshots of the list and the editor for Ron.
- [ ] **Step 6:** Commit `Special days: the Time Slots dialog`. **Stop** and report.

## Step 6 - Seeing it beforehand

### Task 6: Preview this day, the Schedule tab's week chooser, the transitions Preview's date

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js` and its template (Preview this day), `src/special-days.js` (`timetable({ programs, startTime, day, schedule })`, pure: one entry per show or movie with its start, end and title, the rows that won't air, where the list starts again, and the one run-over line or none), `web/directives/channel-config.js` and `channel-config.html` (Schedule tab week chooser; a day's band and chips from the lineup's `specialDay` airings; hatched when not in the lineup), `web/directives/transitions-editor.js` and its template (a "from" date)
- Test: `test/special-days.js` (`timetable`), `test/blocks-schedule-view.js` (a week holding a day)

**Interfaces:** Preview this day lays the day out through the relay worker with the real generator, then reads `timetable` from the result, so what it shows is what Create Lineup saves. **What Ron sees:** a timetable and nothing else - one line per show or movie, start time and title; a row that won't air greyed; a thin rule where the list starts again; under it at most one line, only when the last item runs over ("Runs 14:09 over; back on time at 6:30am"). No Flex lines, no break steps (the transitions Preview has those), no counts.

- [ ] **Step 1: Write the failing tests:** `timetable` on step 2's fixture lineups (each show's and movie's start to the second; "won't air" rows; where the list starts again; the run-over line, and none when the day ends on time); `weeklySegments` for the week of Dec 27 with the day: Toonami from Fri 6:00am to Sat 6:00am, `blocks`' answer elsewhere.
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement; `npm run build`.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the preview:** Preview this day for the New Year's day lists every show and movie at the times the saved lineup on the copy holds, airing for airing, to the second, with no line beyond the timetable and the run-over line. The Schedule tab's week of Dec 27 shows the Toonami band over Fri 6am to Sat 6am with the marathon's chips at their lineup times; the week of Jan 3 shows the regular week. The transitions Preview from Jan 1 walks the day. The workflow checklist on a fresh copy, all passing. Screenshots for Ron.
- [ ] **Step 6:** Commit `Special days: Preview this day, the Schedule tab and the transitions Preview`. **Stop** and report.

## Step 7 - The New Year's checkpoint, live on a copy

### Task 7: Jan 1 as it will air, on a clock-shifted preview

No code in the repo. On `special-days-data`, with the day made in step 5:

- [ ] Clock-shifted to Fri Jan 1, 2027 5:50am: tune in through `/video` on channel 1 (and in TiviMate if Ron wants to watch it): the last regular show, the boundary break with Toonami's sign-on, the first row at 6:00am.
- [ ] Shifted to each movie's start and end: the movie plays whole and the next row starts on its :00 or :30.
- [ ] Shifted to Fri 3:00pm: the regular Toonami hour is the marathon's, with no sign-on.
- [ ] Shifted to Sat Jan 2 5:40am: the day's last item, Toonami's sign-off, CN City (Day), and the regular schedule back on time when the timetable said.
- [ ] Create Lineup during the day (shifted to Jan 1 noon): the program on air stays, the rest of the day is unchanged.
- [ ] Shifted to Jan 2 noon, Create Lineup: the day is listed Aired and ignored; nothing else changes.
- [ ] The guide (XMLTV from the preview) for Jan 1.
- [ ] **Stop** and report to Ron with what aired at each moment. **Then Ron decides** whether to merge into `blocks`, restart 18000 himself, and build the real day on his channel - well before Jan 1. Step 8 follows at once.

## Step 8 - Holiday rows, for Christmas and Halloween

### Task 8: A day's holiday, and rows of a show's set-aside episodes

Right after step 7, for Ron's Christmas Eve 2026 marathon: built, proved and merged well before Thu Dec 24, 2026. Ask Ron which channel and hours the marathon is before its proof, and prove on that channel's copy as well.

**Files:**
- Modify: `src/special-days.js` (`holidayCandidates({ catalogState, showId, holiday })`), `src/services/time-slots-service.js` (a `holidayOnly` row: its own tagged position whatever the mode, in order or shuffled; the show's next regular episode once they have all aired that day), `src/slot-progress.js`, the dialog (Holiday for the day, and "only its <holiday> episodes" on a row)
- Test: `test/special-days.js`, `test/special-days-generator.js`

- [ ] **Step 1: Write the failing tests:** candidates are exactly the episodes left out as that holiday, less never-air; a holiday row never moves a regular position, in an Advance day too; when they run out the row plays the show's next regular episode.
- [ ] **Step 2-4:** fail, implement, `npm test`.
- [ ] **Step 5: Proof on the copy:** a Christmas Eve day on channel 2 (164 Christmas episodes set aside), Hey Arnold!'s row airs "Arnold's Christmas" and its other set-aside Christmas episodes and nothing from its rotation until they're done; the regular Hey Arnold! positions continue exactly after the day; channel 3 likewise with its 48. Ron's own Christmas Eve day, on his channel's copy, through the dialog, with Preview this day, and a clock-shifted look at its first hour and its end. The workflow checklist on a fresh copy, all passing.
- [ ] **Step 6:** Commit `Special days: holiday rows`. **Stop** and report; once Ron merges it and restarts 18000, he builds the real Christmas Eve day.

## Step 9 - Final

### Task 9: Final review and the record

- [ ] Every step's proof re-run on the final code and a fresh copy; the additive check on channels 1-3 at three moments.
- [ ] A code review of the branch against this plan's Review Focus.
- [ ] NOTES.md: the Special days entry gains its Build record; the Scheduling roadmap line and the 1.0 line ticked with what shipped; anything built differently from the design said in its own subsection, as Swaps' "Built differently" does.
- [ ] Commit `Special days: the record`; Ron says when it merges.
