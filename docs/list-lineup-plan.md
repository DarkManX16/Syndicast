# What You See Is What Airs - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a Time Slots channel the programming list is the lineup. Swap changes only the row clicked and the Flex after it; a drag puts a row where it is dropped and shifts the rows between like a playlist; every hand edit is kept where it sits through Create Lineup, later edits, Put back and restarts, until it airs; an episode pushed out airs at its show's next airing; each change says what it does in one sentence. Ron's Friday Oct 30 night on channel 1 - the Venture special dragged to 12:00am, Family Guy swapped at 1:00am - stays exactly as he left it.

**Architecture:** A mark on the row, `kept` (`kind`, `edits`, `was`, `show`, `from`, `made`), replaces `pin` and its clock time: a kept row's time is wherever it sits in the list. One pure module, `src/kept-rows.js`, holds the first-open sort, the list edits (swap in place, run late, take the next row, insert, remove only, drag, Put back), the ripple that moves a position's episodes along, `whyNot` and the sentences. The editor applies edits to its list directly - no re-lay per swap. The generator reads kept rows from the list it is given and fills only the rest; a row kept in time is a one-off slot of its own position at that instant.

**Tech Stack:** Node, AngularJS 1 bundled by browserify, express, the repo's `test/support.js` Suite. No new dependencies.

**Spec:** NOTES.md, Known issues, "What you see is what airs: hand edits kept in the list" (agreed Oct 29, 2026, with Ron's three decisions and the choices listed at its end). Read it before any task; this plan argues from it and does not restate its reasons. Also "Swaps, inserts and Flex that keeps time" (the pin rules the generator keeps for rows kept as they are), "Per-position stored progress" and "Episode start" there.

**Models:** steps 1-3 and 5 are the scheduling core and stored progress: Opus 5.5 end to end (Model guide, "Work that stays on Opus 5 end to end"). Step 4 is editor work: Sonnet 5.5 · High. Step 6 is Opus 5.5.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start. Server-code changes reach 18000 only when Ron restarts it; a merge into `blocks` updates its editor bundle on the next request, and the build check then refuses Swap and Create Lineup until he restarts.
- Code only in the worktree `C:\Projects\dizquetv-worktrees\list-lineup`, branch `list-lineup` (from `blocks` once `list-lineup-design` is merged). `node_modules` is a junction to the main checkout's (`mklink /J`). Never `npm install` in the worktree; a needed dependency goes into the main checkout. None is planned.
- Test only on copies of `.dizquetv-dev`: `C:\Projects\dizquetv-worktrees\list-lineup-proof` (channels, custom shows, filler, `show-aliases.json`) and `list-lineup-data` (a full data folder for the preview, HDHomeRun discovery off, `xmltv-settings.json`'s `file` made absolute). Each step's proof starts from a fresh copy. Before a proof is reported, diff `.dizquetv-dev/channels`, `custom-shows`, `filler` and `show-aliases.json` against the copy, re-copy if they differ, re-run, and state the snapshot time.
- The design's figures (16 and 47 pins still to air, the 11 and 6 shifted airings, the 6 and 1 aired pins) are as of Oct 29, 5:05am. Ron keeps editing and Halloween airs before the build: each proof re-measures them on its copy and says what changed since, rather than expecting the old numbers.
- Plex is read only (GET, token as a header, never printed). Catalog snapshots carry the token in icon URLs: they stay beside the copies and are never committed.
- **Additive:** a list with no `kept` and no `pin` generates program for program what `blocks` generates; playback, the guide, filler, transitions and cards read nothing new; Random Slots channels and channels without a Time Slots schedule are untouched.
- Copy shown to Ron is one plain sentence per change, as in the spec's examples; docs and code never name other playout programs.
- `npm test` passes at the end of every task. Record the count at the start of step 1.
- Commit messages: `Kept rows: <what changed>`, ending with the session's `Co-Authored-By` line. Each step is its own commit; Ron says when the branch merges.
- Live checks: a preview server started by hand from the worktree (`node index.js -p 18220 -d C:/Projects/dizquetv-worktrees/list-lineup-data --unlock`, Bash background), restarted after any server-code change; after any `npm run build`, reload the tab and confirm the served bundle holds the change - a hash-only navigate keeps the old bundle.
- Clock-shifted checks (step 5) use the preload and bundle proxy recorded for the swap-pin-choices check: scratchpad scripts, never in the repo.

## Review Focus

- **Every writer of `channel.programs` keeps `kept`** - the generator's copies (`time-slots-service.js` deletes `copy.pin` today), `slotPool`/`removeDuplicates`, the ~25 programming tools in `channel-config.js`, the drag handlers (`dropFunction`, `endProgramDrag`), the library import, `adjustStartTimeToCurrentProgram`, `cleanUpProgram` (a blacklist, so it does), the migrations, on-demand. Enumerate them all in Task 3, including the ones that pass a program through.
- **The list's time is the only time** - nothing may cache a kept row's instant across an edit. Test in Tasks 1 and 3: an edit before a kept row, then Create Lineup, finds it where the list has it.
- **The ripple** - stops at the lineup's end, skips rows kept as they are, passes through rows kept in time, follows Repeats, and leaves every other position's places untouched (`planProgress` on the result). Test in Task 2.
- **The loop seam** - an aired kept row coming round again is let go, never kept; a kept row near the list's end isn't read twice. Test in Tasks 1 and 3.
- **The fall-back night** (Sun Nov 1, 2026 and Nov 7, 2027) - a drag or ripple across 1:00-2:00am. Times are instants, so nothing should differ: prove it. Test in Tasks 1 and 2.
- **The program on air** - can't be swapped, removed, dragged or dropped before; a kept row on air is carried by Create Lineup like any program. Test in Tasks 1 and 3.

---

## Step 1 - The rules, pure (nothing calls them yet)

### Task 1: `src/kept-rows.js`

**Files:**
- Create: `src/kept-rows.js`, `test/kept-rows.js` (add to `test/run.js`)
- Modify: `src/pins.js` only to export what `kept-rows.js` reuses (`walk`, `carryAt`, `fitAt`, `breaksThatFit`, the clock words); nothing in it changes behaviour yet.

**Interfaces** (lists as the editor holds them: `{ programs, startTime }`; every edit returns a new `programs` array and the sentence, and never touches a row it doesn't name):
- `firstOpen({ programs, startTime, now, schedule, getShowData }) -> { keep: [...], letGo: [...], lines: [sentence] }` - keep: pins still to air where they sit (with their pinned time when different), labelled airings in another show's slot, every airing between a pin and its pinned time; let go: airings no slot made and no pin, pins aired and coming round with the loop. `applyFirstOpen(...) -> programs` converts `pin` to `kept` (`swap`/`insert`/`remove` from `pin.kind`, `moved` for a pin out of place, `shifted` for the airings between) and strips `pin` from what it lets go.
- `swap({ lineup, index, item, choice, now })` - in place, Flex after adjusted; `choice` `'late'` or `'take'` when it doesn't fit, else `null`. `fits(...)` says which apply.
- `insertAfter({ lineup, index, item, now })`, `removeOnly({ lineup, index, now })`.
- `move({ lineup, from, to, now }) -> { programs, shifted: { count, days } }` - the playlist move with the row's Flex; `shifted.days` drives the "more than one night" question.
- `putBack({ lineup, index, now })` - undoes the edit named by the row's `edits`, on the list as it is.
- `whyNot({ lineup, index, now, what, specialDays })` - on air, aired, a drop before the program on air; (Special days' window once it exists).
- `say*` - one sentence per edit, the first-open lines.

- [ ] **Step 1: Write the failing tests** in `test/kept-rows.js`, the machine's zone (America/Chicago), clocks frozen, fixtures as `test/pins.js` builds them (half-hour Play Next slots, 22:00 and 11:00 episodes, Flex to the half hour):
  - `firstOpen: a pin at its time is kept; a pin moved earlier is kept where it sits and the airings between it and its pinned time kept in time; an aired pin coming round is let go; an unlabelled unpinned airing is let go; a list with neither shows nothing`.
  - `firstOpen on channel 1's Friday Oct 30 shape`: the special at 12:00 pinned 3:30, 11 airings after it until 4:00 - keep 1 + 11.
  - `swap: a shorter item - Flex after grows, every other row's start unchanged`; `a longer item that fits - Flex shrinks`; `too long, late - the rows after shift until one starts on time, each kept in time`; `too long, take - the next row is gone, its Flex merged`.
  - `move: earlier - rows between later by the row plus its Flex, back on time where it came from`; `later - the mirror`; `onto its own row - nothing`; `across Sun Nov 1, 2026 1:00-2:00am - every start an exact instant`; `shifted.days` for a two-week move.
  - `putBack` for each kind, after a later edit elsewhere in the same night: the later edit's rows unchanged.
  - `whyNot`: on air, aired, dropping before the program on air.
  - Each `say*` sentence, exactly as the spec's examples.
- [ ] **Step 2:** run `test/kept-rows.js` - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy** (`scripts/kept-check.js`, new, read-only: `--data <copy> --channel <n> --at <ISO> [--first-open] [--swap "<local time>|<S2E20 | #12 | exact title>|<late|take>"] [--move "<from local time>|<to local time>"] [--put-back "<local time>"] [--around "<local time>"]`, edits applied in the order given, the night printed before and after):
  - `--first-open` on channels 1-3: the keep and let-go lines, the counts against the design's Oct 29 figures with what changed since.
  - Channel 1, Ron's Friday as a sequence (on whichever Adult Swim night is still ahead on the copy, the Oct 30 shape rebuilt from the Oct 29 copy if that night has aired): first open; swap Family Guy in the row after the moved special; move the special back to its slot; put back the swap. Each step's night printed; every row the spec says stays, to the second.
- [ ] **Step 6:** Commit `Kept rows: the rules, pure`.

## Step 2 - Episodes move along

### Task 2: The ripple, and stored progress reading kept rows

**Files:**
- Modify: `src/kept-rows.js` (`ripple`; `swap`, `removeOnly`, `take` and `putBack` call it), `src/slot-progress.js` (`placeOf`: `kept` of a kept-as-it-is kind is never a place, as `pin` is now; `shifted` is an ordinary labelled airing), `web/services/common-program-tools.js` (`slotPool` leaves out kept-as-it-is rows, as it leaves out pins)
- Test: `test/kept-rows.js`, `test/slot-progress.js`

**Interfaces:**
- `ripple({ lineup, position, from, direction, getShowData, schedule }) -> { programs, moved: [{ start, before, after }], late: [...] }` - over the position's labelled airings from `from` to the lineup's end, skipping kept-as-it-is rows: forward (a swap, a removal, a take) each takes the previous one's episode, the first the one pushed out; back (Put back) the reverse. Each row keeps its start; the Flex after it takes the difference; an episode longer than its room runs late until a break absorbs it (`late`). A Repeat airing whose source is in `moved` takes its source's new episode.

- [ ] **Step 1: Write the failing tests:** `forward: the pushed-out episode at the next airing, each later one along, to the end`; `a kept-as-it-is airing of the show is skipped, a kept-in-time one takes part`; `back undoes forward exactly`; `two-halves slot: the room is the half`; `a longer episode runs late and says when it's back on time`; `Shuffle position: the round's order moves along the same way`; `a Repeat follows its source`; `planProgress on the result: the swapped position's place is the pushed-out episode at its next airing; every other position's place is unchanged`; `placeOf: kept swap never a place, shifted is`.
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy:** `kept-check.js` with the step 1 sequence on channel 1: after the swap, Paulie (or the episode in that row on the copy) at Family Guy's next airing, every later Family Guy airing one along to the lineup's end, every other airing's show, episode and start unchanged (counted); `planProgress` read from the result: every position continues from the list. Channel 2, a swap of a Hey Arnold! weekday airing (Play Next strip, Friday Shuffle) and of an airing that is a Repeat's source; channel 3 likewise on a weekday strip with a weekend Shuffle. Put back after each: the list identical to before, program for program.
- [ ] **Step 6:** Commit `Kept rows: episodes move along`.

## Step 3 - Create Lineup keeps kept rows

### Task 3: The generator reads kept rows from the list

**Files:**
- Modify: `src/services/time-slots-service.js` (kept rows from `programs` at their list instants; kept-as-it-is placed by the pin rules; `shifted` as a one-off slot of its position at that instant; slots in gaps between kept rows; `then` gone; the carry unchanged; copies keep `kept`), `src/api.js` or wherever `POST /api/channel-tools/time-slots` takes `pins` (stop taking them), `web/directives/time-slots-schedule-editor.js` (Create Lineup and Regenerate send no `pins`; wait for the first-open answer; the note for a kept swap now in another show's slot), `src/kept-rows.js` (`scheduleNotes`), `scripts/progress-check.js` (reads `kept`; `--first-open`, `--swap`, `--move` through `kept-rows.js`)
- Test: `test/pins-generator.js` (its pin cases rewritten as kept rows), `test/kept-rows.js`

**Interfaces:** `timeSlotsService(programs, schedule, ...)` as now, minus `pins`: it reads `kept` itself. A row kept as it is airs at its list instant; a program still on there (only after a ripple ran long) pushes it as rule 1 does now.

- [ ] **Step 1: Write the failing tests:** `no kept rows: deep-equal to blocks' output` (fixtures and the three Oct 29 lists' shapes); `a kept swap at its list time, the slot's own show after it only what fits whole`; `a stretch of kept rows - one moved, eleven shifted - every row at its instant, Flex between, the next slot on time`; `a shifted row gets its position's next episode at its instant`; `an edit before a kept row, then Create Lineup: the row where the list has it`; `a schedule change under a kept swap: the swap stays, scheduleNotes names it`; `the program on air is carried; a kept row on air too`; `an aired kept row coming round with the loop is let go`; `regenerated from its own output: identical to the end`.
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement; enumerate every writer of `channel.programs` (Review Focus) and record which keep `kept` and why.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy**, a fresh catalog snapshot beside it:
  - **Additive:** channels 1-3 with every `pin` stripped and no `kept`, at now, a night-time moment and a moment a week ahead, against the `blocks` checkout's `progress-check --save` with the same pins stripped: 0 programs differ.
  - **Pins at their times:** channel 2's pins that sit at their pinned times, converted by `--first-open`, against `blocks` with those pins: 0 programs differ.
  - **Ron's Friday** (step 1's sequence): Create Lineup after each edit, at now and with the carry mid-night: the kept night identical to the second each time; every position continues (`continue exactly: n of n`); regenerated again from the result, identical to the end.
  - **Channel 2's Friday shape** likewise, with its five out-of-place pins and six shifted airings.
- [ ] **Step 6:** Commit `Kept rows: Create Lineup keeps kept rows`.

## Step 4 - The editor

### Task 4: Swap, Insert, Remove, drag and Put back on the list; the first-open list

**Files:**
- Modify: `web/directives/channel-config.js` and `web/public/templates/channel-config.html` (drop handling on a Time Slots channel through `keptRows.move`, the more-than-a-night question; Delete of a kept row is Put back; Remove this airing only; the library's add as an Insert at the scroll position, "at the end of list" not offered on a Time Slots channel; the whole-list tools' one sentence when kept rows exist; the first-open dialog), `web/directives/airing-swap.js` and its template (Swap and Insert apply `keptRows` edits - no re-lay, no worker; one sentence; Run late / Take the next row when it doesn't fit; the Move mode, red warnings, "re-making also changes", first-swap warning and dropped lists removed), `web/directives/time-slots-schedule-editor.js` (notes), the kept rows' marks in the list (what they replaced, Put back)
- Remove when nothing calls them: `pins.dropSpot`, `slotWarnings`, `pinsMoved`, `outOfPlace`, `sayWarnings`, `sayFirstSwap`, `sayDropped` and friends, `relayEffects`' editor uses; `src/relay-worker.js` stays only if Create Lineup's preview still needs it - check, and say.
- Test: `test/kept-rows.js` (anything pure that moves here), `test/drag-row-kept.js` (a drop on a Time Slots channel goes through `keptRows.move`)

- [ ] **Step 1: Write the failing tests** for the pure parts that move into `kept-rows.js` while wiring, and the drag harness's Time Slots case.
- [ ] **Step 2:** run them - Expected: failures.
- [ ] **Step 3:** Implement; `npm run build`.
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the preview** (port 18220, `list-lineup-data`):
  - Each channel's first open shows the keep and let-go lines step 1 printed for the same copy; Cancel leaves the file untouched and shows them again on reopen; OK and Update Channel save `kept`, no `pin`.
  - Channel 1, Ron's sequence by the editor itself (drag by mouse where the pane allows, else through `dropFunction` and `endProgramDrag` as the drag log records them): after each edit the list on screen, then after Update Channel the saved `channels/1.json`, equal to step 3's Node output program for program. A swap applies in under a second, with no worker re-lay.
  - After Update Channel, the preview server restarted (the one this work started) and the page reloaded: the night as left. Create Lineup, Update Channel: the night as left.
  - A drag across two weeks asks first; Cancel leaves the list.
  - Swap on the program on air is refused in one sentence.
  - Screenshots of the first-open list, a swap's sentence and the Run late / Take choice for Ron.
- [ ] **Step 6:** Commit `Kept rows: the editor`.

## Step 5 - The checkpoint, live on a copy

### Task 5: An Adult Swim night as it will air, on a clock-shifted preview

No code in the repo. On `list-lineup-data`, with the night from step 4 (the next Friday Adult Swim night ahead):

- [ ] Clock-shifted to 11:55pm the evening before: tune in through `/video` on channel 1: the moved special at 12:00am, the swapped Family Guy where the list has it, Robot Chicken's halves in their rows, Harvey Birdman at 4:00.
- [ ] Shifted to 1:10am, mid-night: Create Lineup; the program on air stays and the rest of the night is unchanged; Update Channel; tune in again.
- [ ] The guide (XMLTV from the preview) for the night: every row at the list's time.
- [ ] The swapped-out episode at its next airing, shifted there and tuned in.
- [ ] Report to Ron with what aired at each moment. **Then Ron decides** whether to merge into `blocks` and restart 18000 himself.

## Step 6 - Final

### Task 6: Final review and the record

- [ ] Every step's proof re-run on the final code and a fresh copy; the additive check on channels 1-3 at three moments.
- [ ] A code review of the branch against this plan's Review Focus.
- [ ] NOTES.md: the "What you see is what airs" entry gains its Build record; the 1.0 line and the Library management note ticked with what shipped; anything built differently from the design said in its own subsection.
- [ ] Once `special-days-design` is merged: `docs/special-days-plan.md`'s Tasks 2, 3 and 5 read "kept row" for "pin" and `keptRows.whyNot` for `pins.whyNot`, and refuse a drag inside a day as well as a swap (the spec's "Fit with Special days").
- [ ] Commit `Kept rows: the record`; Ron says when it merges.
