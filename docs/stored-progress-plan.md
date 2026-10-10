# Stored Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every slot or range continues where it left off across a regeneration, and Shuffle, Rerun, Repeat a slot and Ordered shuffle are built on that stored place, with multi-part stories kept together.

**Architecture:** Generators label every airing with its position; the editor, at the moment Create Lineup runs, reads each position's place from the lineup it has loaded (labels, or slot matching for older lineups) and sends it in `schedule.progress`, which is saved with the schedule. All policy - keys, references, reading places, the five-rule precedence, hash rounds, multi-part stories - lives in pure `src/` modules shared by the editor (browserify) and the generators.

**Tech Stack:** Node, AngularJS 1 directives bundled by browserify, the repo's own `test/support.js` Suite. No new dependencies.

**Spec:** NOTES.md, Known issues, "Per-position stored progress, and the shuffles built on it". Read it before any task; this plan argues from it and does not restate its reasons.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start.
- Code changes only in the worktree `C:\Projects\dizquetv\.claude\worktrees\stored-progress` (branch `stored-progress`, from `blocks`). Its `node_modules` is a junction to the main checkout: never run `npm install` in the worktree. No new dependency is planned; any that turns out to be needed is installed in the main checkout.
- Test only on copies of `.dizquetv-dev`. Proof copies live in `C:\Projects\dizquetv-worktrees\stored-progress-data` (full data folder, `xmltv-settings.json`'s `file` made absolute, JSON written without a byte order mark) and `C:\Projects\dizquetv-worktrees\stored-progress-sep29\channels\1.json` (channel 1 from the Sep 29 3am backup). Before a step's proof is reported, diff `.dizquetv-dev/channels`, `custom-shows`, `filler` and `show-aliases.json` against the copy, re-copy if they differ, re-run, and state the snapshot time.
- Every channel saved before this keeps working and is never rebuilt: no migration; both new fields optional; anything that can't be read falls back to the next rule down, never below today's behaviour.
- Docs and code describe the design on its own terms and never name other playout programs.
- Opus 5.5 · Xhigh end to end (NOTES.md, Model guide, "Work that stays on Opus 5 end to end").
- `npm test` passes at the end of every task (1725/1725 at the start).
- Commit messages: `Progress: <what changed>` (area prefix, as the repo's history), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Live checks run a preview server from the worktree on port **18200** against the proof data copy, started with `preview_start` from a `progress-preview` entry in the worktree's `.claude/launch.json`.

## Review Focus

- **A lineup hand-edited after it was generated** - a replaced airing (no label) sitting between labelled ones: it is skipped and the position's place is its next labelled airing. Test in Task 1.
- **The editor left open a long time before Create Lineup** - places are read at the click, not when the dialog opened, so an hour's airings in between count as aired. Test in Task 1 (`now` is a parameter, `programs[0]` is never assumed to be on air).
- **A lineup that has run past its last program and looped** (channel 1 after Aug 3, 2027) - reading wraps round the cycle and reads what is on air. Test in Task 1.
- **Regenerating during the fall-back hour** (Nov 1, 2026, 1:30am CST, second pass) - slot matching must agree with the generator's own `localMsIntoPeriod`/`findSlot` across the change. Test added to `test/dst-fall-back.js` in Task 1, which already pins America/Chicago.
- **A custom show edited between runs** (an item inserted before the place) - a reference resolves by file key first, so the place stays on the same item. Test in Task 2.

---

## Step 1 - Read where every position is (no behaviour change)

### Task 1: Keys, labels and reading places

**Files:**
- Create: `src/slot-progress.js`
- Create: `test/slot-progress.js` (add `'./slot-progress'` to `test/run.js`)
- Modify: `test/dst-fall-back.js` (one added check)

**Interfaces:**
- Produces (all pure, no I/O):
  - `constraintOf(slot, schedule) -> object|undefined` - `slot.seasons`, else `schedule.showConstraints[slot.showId]`; replaces the two services' `constraintForSlot` copies in Task 4.
  - `excludedOf(constraint) -> number[]` - sorted ascending; `startSeason` ignored.
  - `positionKey(showId, mode, constraint) -> string` - `JSON.stringify([showId, mode, excludedOf(constraint)])`.
  - `label(mode, constraint, round) -> string` - `"next|2"`, `"next|"`, `"shuffle|1,2|3"`, `"repeat"`; round only for `shuffle`, `rerun`, `ordered`.
  - `parseLabel(s) -> { mode, excluded, round } | null` - `round` is `null` where absent; anything unparseable is `null`.
  - `ref(program, getShowData) -> { key, order }` - `key` is `serverKey + '|' + key`, `order` is `getShowData(program).order`.
  - `slotAt(schedule, instant) -> slot|null` - the generator's `localMsIntoPeriod` + `findSlot` arithmetic.
  - `readPlaces({ programs, startTime, now, schedule, getShowData }) -> Map<positionKey, { program, start, round, legacyShuffleOrder }>` - per position, its first airing on air at `now` or after, walking from `startTime` and round the cycle once. A labelled airing gives its position from `parseLabel` plus the show; an unlabelled one is matched with `slotAt` and counts only if the slot's show is the airing's show (`legacyShuffleOrder` from its `shuffleOrder`, and a Shuffle-slot airing *without* one is treated as hand-placed and skipped); a `repeat` label never counts.

- [ ] **Step 1: Write the failing tests** in `test/slot-progress.js`, with fixtures built like `test/channel-library.js`'s `episode()` and a weekly schedule:
  - `positionKey ignores startSeason`: `positionKey('tv.A','next',{excludeSeasons:[2,1],startSeason:3}) === '["tv.A","next",[1,2]]'`.
  - `label round-trips`: `parseLabel(label('shuffle',{excludeSeasons:[1]},4))` deep-equals `{mode:'shuffle',excluded:[1],round:4}`; `parseLabel('next|')` gives `excluded: []`, `round: null`.
  - `two ranges of one show read separately`: a lineup with Johnny Bravo all-seasons Thu, no-S1 Fri, no-S2 Sun slots; `readPlaces` at a Friday returns three keys with three different programs.
  - `the airing on air counts as not aired`: `now` 5 minutes into an airing returns that airing.
  - `a hand-replaced airing is skipped`: labelled S1E3, unlabelled S9E9, labelled S1E4 for the same position, `now` before S9E9 - place is S9E9's position's next labelled airing, S1E4.
  - `now is the click, not programs[0]`: same lineup, `now` an hour later than the rotation point - the place moves past the airings in that hour.
  - `a looped lineup reads the cycle`: `now` two cycles after `startTime` reads the same as `now` one cycle earlier plus nothing else.
  - `old lineups are read by slot`: no labels anywhere; every airing's position equals the slot covering its start; a Shuffle-slot airing with `shuffleOrder: 7` gives `legacyShuffleOrder: 7`; a repeat-labelled airing is ignored.
- [ ] **Step 2:** Add to `test/dst-fall-back.js`: `slotAt agrees with the generator through the fall-back hour` - for every minute from Sun Nov 1 05:00Z to 09:00Z, `slotAt(schedule, t)` equals the slot found by `liftSource('src/services/time-slots-service.js','localMsIntoPeriod')` plus a lifted `findSlot` over the same slots.
- [ ] **Step 3:** Run `npm test` - the new checks FAIL (module missing).
- [ ] **Step 4:** Implement the interfaces above in `src/slot-progress.js`.
- [ ] **Step 5:** Run `npm test` - all pass.
- [ ] **Step 6:** Commit: `Progress: read each position's place from a lineup, by label or by slot`.

### Task 2: References that survive a changing pool

**Files:**
- Modify: `src/slot-progress.js`, `test/slot-progress.js`

**Interfaces:**
- Produces: `resolveRef(refValue, sortedCandidates, getShowData) -> index` - the candidate whose file key matches; else the first whose order is at or after `refValue.order`; else 0 (wrap).

- [ ] **Step 1: Failing tests:** `a reference resolves by key` (custom show with an item inserted before the place - index moves, item stays the same); `a gone episode resolves to the next one` (key absent, order between two candidates - the later one); `past the end wraps to the first`.
- [ ] **Step 2:** `npm test` - FAIL. **Step 3:** implement. **Step 4:** `npm test` - pass.
- [ ] **Step 5:** Commit: `Progress: references by file key, falling back to order`.

### Task 3: The proof tool

**Files:**
- Create: `scripts/progress-check.js`

**Interfaces:**
- Consumes: `readPlaces`, `slotAt`; the real `src/services/time-slots-service.js`; `web/services/get-show-data.js` and `web/services/common-program-tools.js` (`require(...)(getShowData)`) for `removeDuplicates`.
- Produces: `node scripts/progress-check.js --data <dir> --channel <n> --at <ISO> [--edit <module.js>] [--from <channel.json>] [--save <out.json>] [--airings <regex> --days <n>] [--show <regex>]`. It drives the editor's path - rotate at `--at` the way `adjustStartTimeToCurrentProgram` does, `removeDuplicates`, the planner once Task 6 exists, the real generator with `Date` frozen at `--at` (as `test/dst-fall-back.js`'s `generate`) - and prints, per position, the saved lineup's next four episodes against the regenerated one's, then `continue exactly: X of Y`. `--edit` exports `(schedule) => void` applied to the schedule before generating; `--save` writes the regenerated channel so a second run can start from it.

- [ ] **Step 1:** Write the script (an extension of the session's scratch harness, using the real `removeDuplicates`).
- [ ] **Step 2: Proof, real data, behaviour unchanged.** On fresh copies, at Fri Oct 9 10:00am, Mon Oct 12 10:00am and Sat Oct 10 11:00pm Central, for channels 1, 2, 3 and Sep 29's channel 1:
  - `readPlaces` matches every airing of the next three weeks to a slot of its own show (3,450 of 3,450 at Friday, as measured);
  - the "today" numbers reproduce NOTES' table exactly: ch 1 138/138, Sep 29 45/50, ch 2 159/164, ch 3 147/155 Friday and 137/155 Monday, with the same before/after episodes.
- [ ] **Step 3:** Commit: `Progress: scripts/progress-check.js, the before-and-after report for a regeneration`.

---

## Step 2 - Play Next continues from its own place

### Task 4: Generators start positions from records and label their airings

**Files:**
- Modify: `src/services/show-orderers.js` (new `createPositions`; `getShowOrderer` and its `resumePosition` founder rule move inside it; `getShowShuffler` stays until Task 9)
- Modify: `src/services/time-slots-service.js`, `src/services/random-slots-service.js`
- Create: `test/progress-generators.js` (add to `test/run.js`)

**Interfaces:**
- Consumes: `constraintOf`, `positionKey`, `label`, `resolveRef`.
- Produces: `createPositions({ shows, schedule, getShowData }) -> { forSlot(slot) -> { current() -> program|null, next() } }`, `shows` being the services' existing show list (`show.programs`, `show.founder`). A Play Next position starts at `schedule.progress.positions[key].next` (via `resolveRef` over its sorted, range-filtered candidates); a position with no record uses today's founder rule; a record carrying `legacyShuffleOrder` starts the old shuffler there instead of at `founder.shuffleOrder`. `current()` returns a fresh copy with `shuffleOrder` and `slotPosition` removed, then `slotPosition = label(...)` set (the old shuffler still sets its own `shuffleOrder`). A Play Next record gains `wrapped: true` once its position passes the end of its range (kept for Rerun; nothing reads it yet).

- [ ] **Step 1: Failing tests** (fixtures, the real services, `Date` frozen):
  - `every airing carries its position`: all non-flex programs have a `slotPosition` that `parseLabel` reads and that matches their slot.
  - `Play Next airings never carry a Shuffle number`: a show with a Play Next and a Shuffle slot, input programs carrying `shuffleOrder` - no Play Next airing has `shuffleOrder`.
  - `a record sets the place`: progress record `next` = S1E5 for the no-S2 range - that position's first airing is S1E5; the all-seasons range with record S2E3 starts at S2E3, whichever airs first.
  - `no record, no progress: as today`: the same lineup with `schedule.progress` absent is identical (field for field, ignoring `slotPosition`) to the output of `git show blocks:src/services/time-slots-service.js` run on the same input (loaded from a temp file, as NOTES' "Comparing a filler change" describes).
- [ ] **Step 2:** `npm test` - FAIL. **Step 3:** implement; replace both services' `constraintForSlot` with `constraintOf`. **Step 4:** `npm test` - pass.
- [ ] **Step 5:** Commit: `Progress: generators start each position from its record and label every airing`.

### Task 5: Season start becomes a seek; one key for editor and generator

**Files:**
- Modify: `web/services/season-constraints.js` (`keyOf` delegates to `src/slot-progress.js`'s `excludedOf`; `startSeason` no longer part of it)
- Modify: `src/services/show-orderers.js` (remove `constraintKey`)
- Modify: `test/slot-progress.js`

**Interfaces:**
- Produces: `seekOf(slots, schedule, now) -> number|null` in `src/slot-progress.js` - among a position's slots that carry a `startSeason`, the one whose next occurrence after `now` (by `slotAt` arithmetic) comes first.

- [ ] **Step 1: Failing tests:** `slots with one range and different seeks share a position` (`sharingPosition` counts both); `seekOf picks the slot airing first from now`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit: `Progress: season start is a seek on a position, not part of its key`.

### Task 6: The planner - rule precedence and the slot's old place

**Files:**
- Modify: `src/slot-progress.js`, `test/slot-progress.js`

**Interfaces:**
- Produces: `planProgress({ programs, startTime, now, openedSchedule, schedule, pool, getShowData }) -> { asOf, positions }` for every position in `schedule`, by the spec's five rules in order: a seek (`seekOf`, first episode of that season); `readPlaces` on air or ahead; `openedSchedule.progress.positions[key]`; the slot's old place (same `time` and `showId` in `openedSchedule`, same mode, moved forward with `resolveRef` into the new range; several old positions - the one airing first from `now` wins); otherwise the first episode of the range. Unused positions' records from `openedSchedule.progress` are carried into the result unchanged. Unlabelled Random Slots lineups (no `time` on slots) produce no record for that position, so the generator's founder rule applies.

- [ ] **Step 1: Failing tests:** one per rule, each where the rule above it does not apply, plus `a seek beats the lineup`, `a range taken out and put back resumes from its record`, `narrowing a range keeps the slot's place, moved forward`, `a mode change starts at the first episode`, `an unused position's record is kept`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit: `Progress: the planner, five rules in order`.

### Task 7: The editor sends and saves progress

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js` (`startDialog` takes a lineup accessor; keeps `scope.openedSchedule`; `doIt` sets `scope.schedule.progress = planProgress(...)` with `now = Date.now()` at the click)
- Modify: `web/directives/random-slots-schedule-editor.js` (the same, for `randomScheduleBackup`)
- Modify: `web/directives/channel-config.js` (the five `startDialog` calls pass `() => ({ programs: scope.channel.programs, startTime: scope.channel.startTime })`)
- Modify: `scripts/progress-check.js` (calls `planProgress` as the editor does)

- [ ] **Step 1:** Implement; `npm run build` in the worktree; `test/bundle-freshness.js` passes.
- [ ] **Step 2: Proof, real data** (`progress-check` at the three moments, every channel copy):
  - Every Play Next position continues exactly: ch 1 138/138, Sep 29 50/50 (Johnny Bravo S01E28, S02E07, S01E34, S01E34), ch 2 All That S01E05, Rugrats S01E05, Hey Arnold S01E09, Kenan & Kel S01E05; ch 3's eight weekday strips; Monday's 18 weekend Shuffles continue exactly through `legacyShuffleOrder`.
  - Hey Arnold's Friday Shuffle resumes at pick 1 (S1E9), not at Ron's hand-placed S5E5 - hand edits never move a position.
  - Channel 1 as saved regenerates field for field the same as `blocks`' generator, ignoring `slotPosition`: nothing changes where nothing was wrong.
  - Twice in a row: Friday's output saved, then regenerated from it at Monday - every position continues exactly, now read from labels.
  - The slot's old place, on copies with `--edit`: Rugrats' Friday range changed from no S1-5 to no S1-6 goes to S07E01; All That's Fri-Sun range narrowed to no S1-7 continues at the first S8 episode at or after its place; Sep 29's no-S2 Johnny Bravo slots removed in one run and restored in the next resume at S01E34 from the record.
- [ ] **Step 3: Live check** on the preview (port 18200): open channel 2, Time Slots, Create Lineup, Update Channel; `progress-check --from` the saved file shows `progress` with 164 positions and every airing labelled; no console errors.
- [ ] **Step 4:** Commit: `Progress: the editor reads places at Create Lineup and saves them with the schedule`; record step 2 in NOTES.md (what shipped, the measurements, snapshot time).

---

## Step 3 - Shuffle rounds by episode, multi-part stories, seasons on Shuffle

### Task 8: Multi-part stories

**Files:**
- Create: `src/multi-part.js`, `test/multi-part.js` (add to `test/run.js`)

**Interfaces:**
- Produces: `partOf(title) -> { base, n } | null` (markers `(2)`, `(II)`, `Part 2`, `Part Two`, `Pt. 2`, n 1-6); `stories(sortedPrograms) -> program[][]` - every program in exactly one story; part n (n >= 2) joins the one before it when that is part n-1, or for part 2 when that has the same title unmarked.

- [ ] **Step 1: Failing tests** with Ron's real titles as fixtures: `Deadomutt (1)/(2)` join; `Stewie Kills Lois (1)` + `Lois Kills Stewie (2)` join; `Judging Omi (1)`, `Saving Omi (2)`, `Finding Omi (3)` make one story of three; `Secret Origins`, `Secret Origins (2)`, `Secret Origins (3)` make one; `Escape to the House of Mummies Part II` after `Assassinanny 911` stays single; `The Thirteen Ghosts (1975)` is not a part; Sonic Underground's interleaved `(Chaos Emerald Crisis, Part 2)` / `(Origins, Part 2)` stay single.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass.
- [ ] **Step 5: Proof, real data:** across channels 1-3, 431 stories, 1,022 episodes, 24 parts single - the list printed matches NOTES'.
- [ ] **Step 6:** Commit: `Progress: multi-part stories from part markers and order`.

### Task 9: The shuffle family's rounds

**Files:**
- Create: `src/shuffle-rounds.js`, `test/shuffle-rounds.js` (add to `test/run.js`)
- Modify: `src/services/show-orderers.js` (Shuffle positions use rounds; `getShowShuffler` removed), `src/slot-progress.js` (`planProgress` turns `legacyShuffleOrder` and the slot's old place into a `queue`)

**Interfaces:**
- Produces: `hash32(s) -> number` (FNV-1a, 32-bit); `roundOrder({ seed, round, stories, laterHalf }) -> stories` - `seed` is the position key; sorted by `hash32(seed + '|' + round + '|' + story[0] file key)`, ties by key, stories in `laterHalf` (a set of first-episode keys) after all others; `laterHalfOf(order) -> Set` - the first-episode keys of the later half of an order.
- A shuffle record is `{ round, next }` or `{ round, queue }`. `queue` is played in order first (a carried round), filtered to the current range; then rounds continue from `round + 1` with `laterHalf` taken from the queue's last half. In steady state the place is `next`'s story; everything before it in the round's order counts as aired this round. Labels are `label(mode, constraint, round)`.
- `planProgress`: for a `legacyShuffleOrder` place, `queue` = the rest of that round in the old permutation, reproduced by the old shuffler's arithmetic copied into `src/shuffle-rounds.js` as `legacyRemaining(sortedPrograms, showId, position)`; for a slot's old place in the shuffle family, `queue` = the rest of the old position's round in its order, minus what the new range excludes.

- [ ] **Step 1: Failing tests:** `each round airs every story once`; `none back within half a round` over 20 rounds; `adding an episode leaves the rest of the round in place` (order of the other stories unchanged; the new one airs this round only if its hash is ahead of the place); `excluding a season mid-round reshows nothing early`; `a story's parts are consecutive airings of the position`; `legacyRemaining reproduces the old shuffler` (positions 0..3n against `git show blocks:src/services/show-orderers.js`'s `getShowShuffler`); `a carried queue plays first, in order`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit: `Progress: Shuffle by rounds of episodes, stable when the pool changes`.

### Task 10: Seasons on Shuffle slots, and the round audit

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js` (`canConstrainSeasons` allows `shuffle`; `seasonsDisabledReason` drops the Shuffle text)
- Create: `scripts/progress-audit.js` - `node scripts/progress-audit.js --channel <saved.json>` checks a whole lineup: per shuffle-family position, each round has each story once, no story back within half a round, every story's parts consecutive and in order; prints violations and counts.

- [ ] **Step 1:** Implement; `npm run build`; `npm test` passes.
- [ ] **Step 2: Proof, real data:**
  - Channel 3 at Monday and Friday: all 18 weekend Shuffles continue exactly, and the carried round finishes in the saved lineup's order (next airings compared until each round ends).
  - `progress-audit` on channel 3 regenerated for a year: 0 violations; the multi-part stories in its shuffled shows (from the 13) air whole once new rounds begin.
  - Kim Possible's Saturday and Sunday Shuffle set to no S1 on a copy mid-round: no S1 airing; no story from earlier in the round reshown before it ends.
- [ ] **Step 3: Live check:** the Seasons button is enabled on a Shuffle slot, the range saves, Create Lineup and Update Channel succeed.
- [ ] **Step 4:** Commit: `Progress: season settings for Shuffle slots, and scripts/progress-audit.js`; record step 3 in NOTES.md.

---

## Step 4 - Rerun

### Task 11: Rerun positions

**Files:**
- Modify: `src/services/show-orderers.js`, `src/slot-progress.js`
- Create: `test/progress-rerun.js` (add to `test/run.js`)
- Modify: `web/directives/time-slots-schedule-editor.js` (`orderOptions` gains `{ id: 'rerun', description: 'Rerun' }`; a note under the slot saying it will play as a Shuffle for now, and why, when the show's Play Next hasn't aired anything or there is none)
- Modify: `scripts/progress-audit.js` (a Rerun airing must be an episode its show's Play Next had passed by that airing's start)

**Interfaces:**
- Produces: `registry.airedFor(showId) -> Set<fileKey>` - union over the show's live Play Next positions of every candidate before each one's current place (the whole range once `wrapped`), plus the same for `progress` records of the show's Play Next positions not in the schedule. A Rerun position draws stories wholly inside that set and inside its own range, in Shuffle's rounds; the set is asked afresh at each pick, so it grows as the strips advance. Fallbacks (Ron, Oct 9): nothing aired yet - plays as a Shuffle over its range, and the editor shows why under the slot; no Play Next for the show anywhere - plays as a Shuffle over its range.

- [ ] **Step 1: Failing tests:** `a Rerun never airs an episode its show's Play Next hasn't passed` over a generated year; `the pool grows as the strip advances`; `a story is rerun only once every part has aired`; `a strip that has gone round makes its whole range eligible`; `nothing aired yet plays as a Shuffle`; `no Play Next plays as a Shuffle`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass; `npm run build`.
- [ ] **Step 5: Proof, real data:** a copy of channel 3 with the weekend Shuffle slots of Kim Possible, Lizzie McGuire, Even Stevens and The Proud Family set to Rerun, generated for a year: `progress-audit` reports 0 Rerun airings ahead of their strip, and each show's pool size at the first and last weekend; regenerated again three months in from the saved output, every Play Next and Rerun position continues exactly.
- [ ] **Step 6: Live check:** Rerun offered; the note shows, with its reason, on a show with no Play Next.
- [ ] **Step 7:** Commit: `Progress: Rerun, a Shuffle of what Play Next has already aired`; record step 4 in NOTES.md.

---

## Step 5 - Repeat a slot

### Task 12: Repeat in the generator

**Files:**
- Modify: `src/services/time-slots-service.js` (tracks each program's start; a `repeat` slot's `current()` returns the next of its source occurrence's airings, or `null` once they are used up, and `null` fills the rest of the slot with Flex), `src/api.js` (passes `req.body.history`), `web/services/dizquetv.js` (`calculateTimeSlots(programs, schedule, history)`)
- Modify: `src/slot-progress.js` - `recentAirings({ programs, startTime, now, spanMs, since }) -> Array<{ start, program }>`: the airings that started in `[now - spanMs, now)`, read back round the lineup's loop, none before `since` (the opened schedule's `progress.asOf`, when there is one); called with one period plus an hour
- Create: `test/progress-repeat.js` (add to `test/run.js`)

**Interfaces:**
- A repeat slot: `{ time, showId, order: 'repeat', repeatOf }`, `repeatOf` the source slot's `time`, `showId` the source's. Its occurrence at `t` re-airs the programs of `showId` that started inside the source slot's latest occurrence before `t` - found by local wall-clock time, at most one period plus an hour back - from the lineup being built, else from `history`; each copied with `slotPosition = 'repeat'`. A source occurrence with nothing in it (Flex, or before `since`) plays a Rerun of the same show (Ron, Oct 9).

- [ ] **Step 1: Failing tests:** `a repeat re-airs its source's episodes`; `Saturday repeats Thursday, Sunday repeats Friday` (a weekly fixture shaped like channel 3's That's So Raven: Thu 18:30 and Fri 18:00 Play Next, Sat 18:30 and Sun 17:00 Repeat); `a same-day repeat: 9pm again at 1am`; `a source after the repeat in the week repeats last week's` (Thursday repeating Saturday plays the Saturday five days earlier); `two episodes in the source, two in the repeat, as many as fit`; `the first repeat after a regeneration comes from history, read back round the loop`; `a repeat never moves its source's position` (regenerate two days later - the source's Play Next continues exactly); `on the fall-back night a 1:00 repeat airs twice, the same episodes`; `nothing in the source plays a Rerun`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass.
- [ ] **Step 5:** Commit: `Progress: Repeat a slot re-airs what a chosen earlier slot aired`.

### Task 13: Repeat in the editor

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js`, `web/public/templates/time-slots-schedule-editor.html` (`orderOptions` gains `{ id: 'repeat', description: 'Repeat a slot' }`; a Repeat slot shows a source picker listing every slot that isn't itself a Repeat, each with the occurrence it will repeat ("Thu 6:30pm, two days earlier"), and takes the source's show; retiming a source moves its repeats' `repeatOf`; a repeat whose source is gone or has become a Repeat is marked and blocks Create Lineup, saying why), `web/directives/time-slots-time-editor.js` if the retime path needs it
- Modify: `scripts/progress-audit.js` (every repeat airing equals its source occurrence's airings)

- [ ] **Step 1:** Implement; `npm run build`; `npm test` passes.
- [ ] **Step 2: Proof, real data - channel 3's That's So Raven.** A copy of channel 3 with Saturday 6:30pm set to Repeat of Thursday 6:30pm and Sunday 5:00pm to Repeat of Friday 6:00pm, regenerated at Fri Oct 9 10:00am:
  - Saturday Oct 10 airs S01E01 "Mother Dearest" (Thursday Oct 8's, from the lineup on air, read back round its loop) and Sunday Oct 11 airs S01E02 "Test of Friendship" (Friday Oct 9's, from the new lineup), as previewed in NOTES;
  - `progress-audit` over the whole lineup: every Saturday equals that week's Thursday and every Sunday that week's Friday, 0 mismatches;
  - regenerated again from the saved output at Mon Oct 12 10:00am: the Thursday/Friday Play Next strip continues exactly (S01E03 next), and the repeats still match.
  - A same-day check on a copy of channel 1: one 1:00am slot set to Repeat of the previous evening's 9:00pm, 0 mismatches across the lineup.
- [ ] **Step 3: Live check:** the picker lists That's So Raven's Thursday and Friday slots with the occurrence each would repeat; retiming Thursday 6:30pm moves Saturday's source with it; deleting it marks Saturday and Create Lineup is refused with the reason.
- [ ] **Step 4:** Commit: `Progress: the Repeat a slot source picker`; record step 5 in NOTES.md.

---

## Step 6 - Ordered shuffle

### Task 14: Ordered shuffle positions

**Files:**
- Modify: `src/services/show-orderers.js`, `src/shuffle-rounds.js`
- Create: `test/progress-ordered.js` (add to `test/run.js`)
- Modify: `web/directives/time-slots-schedule-editor.js` (`orderOptions` gains Ordered shuffle, offered only for a show whose items have two or more series; the row says how many), `scripts/progress-audit.js` (per series, items in list order with no skip; every item once per round; per-round counts equal series sizes)

**Interfaces:**
- Produces: `seriesOf(program) -> string` - the item's `showTitle`, else its title. A round is `roundOrder` over all stories; the k-th story of series S in that order plays S's k-th story in custom-show list order. Record `{ round, next }`, as Shuffle; the place in the round is found from `next`'s series and its index within it. Default to confirm with Ron: shares by series size (every item once per round), not equal per series.

- [ ] **Step 1: Failing tests:** `each series plays in list order`; `every item once per round`; `per-round counts equal series sizes`; `a series' multi-part story stays together`; `a regeneration mid-round continues`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass; `npm run build`.
- [ ] **Step 5: Proof, real data:** copies with channel 1's Tom & Jerry slots (four series, 164/49/14 items with the stray single-item one) and channel 2's Double Dare Series (Shuffle) slot (186/118/94/67) set to Ordered shuffle, generated for a year: `progress-audit` reports 0 violations and per-round series counts; regenerated mid-round, continues exactly.
- [ ] **Step 6: Live check:** Ordered shuffle offered for Tom & Jerry, not for Johnny Bravo.
- [ ] **Step 7:** Commit: `Progress: Ordered shuffle, a series at random and its next episode`; record step 6 in NOTES.md.

---

## Step 7 - Docs and handover

### Task 15: Record what shipped

**Files:**
- Modify: `NOTES.md` (tick the six Scheduling roadmap lines with what actually shipped; the 1.0 must-list line; the Known issues entry's status line; a Testing notes entry for `progress-check` and `progress-audit`), `docs/stored-progress-plan.md` (boxes ticked)

- [ ] **Step 1:** Re-copy the data, diff, re-run every step's proof on the fresh copy, state the snapshot time.
- [ ] **Step 2:** Write the NOTES changes.
- [ ] **Step 3:** Commit: `Docs: record stored progress, shuffle, rerun, repeat a slot and ordered shuffle`. The branch stays unmerged until Ron says to merge it into `blocks`.
