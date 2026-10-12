# Swaps and Inserts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ron swaps an airing for another episode or item, or inserts one in a break, pinned to its date and time; the Flex around it grows or shrinks so everything after keeps its time, Create Lineup keeps the pin until it airs, and whatever it pushes out airs at its show's next slot.

**Architecture:** A pin is a mark (`program.pin`) on an airing in `channel.programs`. The Time Slots generator places pins by the spec's four rules; the editor reads the pins still to air from the lineup on air, and every swap, insert or undo re-lays the lineup through the generator exactly as Regenerate does. What the editor needs to say about a pin - where it fits, what a re-lay moved, ran late or dropped - lives in one pure module, `src/pins.js`, bundled like `src/episode-start.js`.

**Tech Stack:** Node, AngularJS 1 bundled by browserify, express, the repo's `test/support.js` Suite. No new dependencies.

**Spec:** NOTES.md, Known issues, "Swaps, inserts and Flex that keeps time" (agreed Oct 11, 2026, with Ron's four decisions). Read it before any task; this plan argues from it and does not restate its reasons.

## Global Constraints

- Never stop, restart or signal the server on port 18000, or any process this work didn't start.
- Code only in the worktree `C:\Projects\dizquetv\.claude\worktrees\swaps`, branch `swaps` (from `blocks` at edeb025). `node_modules` resolves from the main checkout: never `npm install` here; a needed dependency goes into the main checkout. None is planned.
- Test only on copies of `.dizquetv-dev`: `C:\Projects\dizquetv-worktrees\swaps-proof` (channels, custom shows, aliases) and `swaps-data` (a full data folder for the preview, HDHomeRun discovery off, `xmltv-settings.json`'s `file` made absolute). Before a step's proof is reported, diff `.dizquetv-dev/channels`, `custom-shows`, `filler` and `show-aliases.json` against the copy, re-copy if they differ, re-run, and state the snapshot time.
- Plex is read only (GET, token as a header, never printed). Catalog snapshots carry the token in icon URLs: they stay beside the copies and are never committed.
- Additive: a lineup with no pins generates program for program what it generates now; a channel without a Time Slots schedule behaves exactly as now.
- Copy shown to Ron is plain English, as in the spec's examples; docs and code never name other playout programs.
- `npm test` passes at the end of every task (2009/2009 at the start).
- Commit messages: `Swaps: <what changed>`, ending with the session's `Co-Authored-By` line.
- Live checks: a preview server started by hand from the worktree (`node index.js -p 18200 -d C:/Projects/dizquetv-worktrees/swaps-data --unlock`, Bash background), restarted after any server-code change; after any `npm run build`, reload the tab and confirm the served bundle holds the change - a hash-only navigate keeps the old bundle.

## Review Focus

- **A pinned Flex next to break Flex** - the generator's `pushFlex` merges adjacent Flex; merged, the pin is lost or its length changes. Test in Task 1.
- **A Repeat whose source slot holds a pin of its show** - the copy must not carry `pin`, or the next run finds two pins at one time. Test in Task 1.
- **A pin a fraction of a second after a slot's start** (Ron's saved lineups start 0.6-1 s off the minute) - the slot's own episode must not squeeze in before it. Test in Task 1.
- **The Nov 1 fall-back night** - a pin in the repeated 1:00-2:00 hour airs once, at its instant. Test in Task 1.
- **A re-lay that drops something placed by hand** - named before it happens, never silently. Test in Task 3.

---

## Step 1 - The generator places pins (no editor change)

### Task 1: Pins in the Time Slots generator, the API, and `progress-check --pin`

**Files:**
- Modify: `src/services/time-slots-service.js`, `src/api.js` (the `/api/channel-tools/time-slots` route), `web/services/dizquetv.js` (`calculateTimeSlots`)
- Modify: `scripts/progress-check.js`
- Create: `test/pins-generator.js` (add `'./pins-generator'` to `test/run.js`)

**Interfaces:**
- Produces: `timeSlotsService(programs, schedule, history, pins)` - `pins` optional, `[{ at: ms, then: 'take'|'late', program }]`, `program` carrying its `pin` mark (spec's Shapes). Placed airings keep `pin` and lose `slotPosition` and `shuffleOrder`. Pins whose `at + program.duration <= now` are ignored. A pinned Flex (`program.isOffline`) is pushed as its own entry, and `pushFlex` never merges into an entry with `pin`.
- Produces: `POST /api/channel-tools/time-slots { programs, schedule, history, pins }`; `dizquetv.calculateTimeSlots(programs, schedule, history, pins)`.
- Produces: `progress-check --pin "<local time>|<showId>|<S0E7 | #12 | exact title>|<take|late>[|insert]"` (repeatable; the item from `--catalog`'s snapshot, else the pool), pins read back from a `--from` lineup by default, `--around "<local time>"` (the 3 hours either side, saved vs regenerated, with Flex after each), `--changed <days>` (airings whose start or episode differ, counted by show).

The four rules, as the generator applies them (`SLACK` is `constants.SLACK`):
- R1: a pin is due when `at <= t + SLACK`; it is placed at `t`. While filling a slot that a pin falls inside, items are taken only while their start is before `at - SLACK`; the last may run past `at` (the pin then waits), else Flex to `at`.
- R2: in the slot the pin started in, after it, only items that fit whole before the slot's end; no slide.
- R3: a slot that starts while a pin is on and ends before it is Flex. The slot it ends in: `take` - Flex; `late` - from the pin's end, items one after another without padding or the 5-minute rounding, the first allowed to run past the slot's end, Flex to the slot's end if any is left; later slots the same until one starts within `SLACK` of its time.
- R4 needs no code: positions advance only when their item is placed.

- [ ] **Step 1: Write the failing tests** in `test/pins-generator.js`: fixtures as `test/progress-generators.js` builds them (frozen clock, the machine's zone), a daily schedule of half-hour slots - A 7:00pm, B 7:30pm, C 8:00pm, D 8:30pm, Flex the rest, Play Next, 22:00 episodes, `pad` 5 minutes - generated from Thu Oct 8, 2026 noon unless a test says otherwise:
  - `no pins: the same lineup as without the argument` - `pins` undefined, `[]` and absent give deep-equal `programs` and `startTime`.
  - `a swap that fits: at its time, Flex to the next slot, the next slot on time` - a 24:06 item pinned Thu 7:30pm: it starts at 7:30:00, C starts at 8:00:00, the Flex between is 5:54.
  - `...and the episode it pushed out airs at its show's next slot` - Fri 7:30pm airs the B episode Thu would have aired; every later B airing is one along.
  - `the pinned airing keeps its pin and no label` - `pin.at` as given, no `slotPosition`, no `shuffleOrder`.
  - `too long, take: the slot it runs into is Flex and its episode waits` - a 44:09 item at Thu 7:00pm: Flex from 7:44:09 to 8:00:00, C at 8:00:00, Thu's B episode airs Fri 7:30pm, A's Thu episode Fri 7:00pm.
  - `too long, late: the next show starts the moment it ends, then back on time` - the same at `late`: B at 7:44:09, C at 8:06:09, D at 8:30:00; no start between 7:44:09 and 8:30 is rounded to 5 minutes.
  - `a slot it covers whole is taken over, even running late` - a 76:40 item at 7:00pm, `late`: no B on Thu, C at 8:16:40.
  - `two halves: a pin over the first takes the slot and both halves wait` - an 11:00-episode show in the 7:00 slot (two a slot), a 22:38 item at 7:00: Flex 7:22:38-7:30, both halves Fri 7:00 and 7:15.
  - `an insert after a program takes its time from the break` - a 5:00 item pinned at A's end (7:22:00): B at 7:30:00, the Flex between the item and B 3:00.
  - `an insert 11 seconds too long, late: the next show starts 11 seconds late` - an 8:11 item at 7:22:00: B at 7:30:11, C at 8:00:00.
  - `a pin waits for a program still on at its time` - a pin at 7:20:00 while A runs to 7:22:00: it starts at 7:22:00.
  - `a pin 0.645 seconds after a slot's start is that slot's` - pinned at 7:30:00.645: no B airing Thu, the item starts within 1 s of 7:30:00.
  - `a pinned Flex keeps its own entry and length` - `{ isOffline: true, duration: 22 * MIN, pin }` at 7:30: an entry with that `pin` and exactly 22:00, followed by a separate Flex of 8:00.
  - `a pin that has aired is gone; one on air starts again now` - clock at Thu 7:40pm: a pin that ended at 7:24 is absent; a 24:06 pin at 7:30 starts at 7:40:00.
  - `a Repeat of a slot holding a pin of its show re-airs it without the pin` - on a weekly schedule, a Sat 7:30pm Repeat of Thu 7:30 (B), B's special pinned Thu 7:30: Sat's airing is the special, `slotPosition` `'repeat'`, no `pin`.
  - `on the fall-back night a pin in the repeated hour airs once, at its instant` - a 1:00am and 1:30am slot on Nov 1, 2026, a pin at 1:30am CST (07:30Z): it starts at 07:30:00Z, once; the 1:30am CDT airing (06:30Z) is the slot's own.
- [ ] **Step 2:** `node -e "require('./test/pins-generator')().then(s=>console.log(s.failures))"` - Expected: failures (pins ignored).
- [ ] **Step 3:** Implement the rules in `time-slots-service.js`; pass `req.body.pins` in the route and `pins` in `calculateTimeSlots`. Strip `pin` in `repeatFor`'s copy as `shuffleOrder` already is.
- [ ] **Step 4:** `npm test` - Expected: all pass, 2009 + the new ones.
- [ ] **Step 5:** Add `--pin`, `--around` and `--changed` to `scripts/progress-check.js`.
- [ ] **Step 6: Proof on the copy**, a fresh catalog snapshot beside it, regenerated at the time of the run:
  - **Additive:** channels 1-3 with no pins, at now, Sat Oct 31 noon and Mon Dec 21 10am, against the `blocks` checkout's `progress-check --save`: 0 programs differ.
  - **The spec's table, by the real generator:** Arnold's Christmas on channel 2 Thu Dec 24 7:30pm (5:54 of Flex; Best Man / Cool Party Mon Dec 28 6:30pm; over 300 days only Hey Arnold! changes); A Johnny Bravo Christmas on channel 1 Thu Dec 24 5:30pm (halves Fri Dec 25 6:30 and 6:45); 'Twas the Fight Before Christmas, channel 1 Thu Dec 24 8:00pm, `take` and `late` (Kids Next Door Fri Dec 25 8:00pm; or 8:44, Pokémon 9:07, Yu-Gi-Oh! 9:30); A Hero for Halloween on channel 3 Sat Oct 31 4:00pm (Rene Sun Nov 1 4:30pm; only The Proud Family changes); The Night Before Christmas (1933) on channel 3 after Sister, Sister, `late` (That's So Raven 6:30:10) and after Boy Meets World (0:58 of Flex). Each matches the probe's figures, or the difference is explained.
  - **Twice in a row:** each result regenerated with its pins read back, before the pin, while it is ahead and after it aired: identical airing for airing to the end of the first.
- [ ] **Step 7:** Commit `Swaps: the Time Slots generator places pins`.

## Step 2 - Pins never count as a place and never join a pool

### Task 2: `src/pins.js` (the mark), `placeOf`, and every pool built from the lineup

**Files:**
- Create: `src/pins.js`, `test/pins.js` (add `'./pins'` to `test/run.js`)
- Modify: `src/slot-progress.js` (`placeOf`), `web/services/common-program-tools.js` (`slotPool`), `web/directives/channel-config.js` (the five `removeDuplicates(scope.channel.programs)` that hand the slot editors their pool), `web/controllers/channel-catalog.js` (its `lineupPool`), `scripts/progress-check.js`, `scripts/progress-audit.js`, `scripts/catalog-snapshot.js`
- Test: `test/slot-progress.js`

**Interfaces:**
- Produces (pure, in `src/pins.js`):
  - `makePin({ program, at, kind, then, was, slotShow, now }) -> program` - a copy (JSON round trip) without `slotPosition`, `shuffleOrder`, `start`, `stop`, `$index`; `pin = { at, kind, then, was, slotShow, made: ISO(now) }`, `was` omitted when absent.
  - `removalPin({ airing, at, slotShow, now }) -> program` - `{ isOffline: true, duration: airing.duration, pin: { at, kind: 'remove', then: 'take', was: label(airing), slotShow, made } }`.
  - `pinsAhead({ programs, startTime, now }) -> [{ at, then, program }]` - airings with `pin` whose `pin.at + duration > now`, read once round the loop from `now`, in `at` order.
  - `label(program) -> string` - "Hey Arnold! S03E23 Best Man / Cool Party"; a custom-show item "Silly Symphonies #12 The Night Before Christmas (1933)"; a movie its title.
- Produces: `commonProgramTools.slotPool(programs) -> program[]` - `removeDuplicates` of the programs without a `pin`.
- Modifies: `slotProgress.placeOf` returns `null` for an airing with `pin`, labelled lineup or not.

- [ ] **Step 1: Write the failing tests:**
  - `test/slot-progress.js`: `a pinned airing is never a place, in a lineup without labels` - an unlabelled lineup whose first Play Next airing ahead in a slot is a pinned special of that show (season 0): `readPlaces` gives the next unpinned airing; `...nor in a labelled one`.
  - `test/pins.js`: `makePin strips labels and numbers and records the pin`; `removalPin is Flex of the airing's length, kind remove`; `pinsAhead reads pins that end after now, in time order, round the loop`; `...and not one that has aired`; `slotPool leaves pinned airings out` (a pinned copy of a rotation episode leaves the rotation's own copy in).
- [ ] **Step 2:** Run both files - Expected: failures.
- [ ] **Step 3:** Implement; replace the nine pool sites with `slotPool` (enumerated in Files; `show-config.js`'s `removeDuplicates(scope.content)` is a custom show's own list and stays).
- [ ] **Step 4:** `npm test` - Expected: all pass.
- [ ] **Step 5: Proof on the copy:** the hazard first, on the `blocks` checkout: "Arnold's Christmas" hand-placed in channel 2's Thu Dec 24 7:30pm airing (no mark), Create Lineup's path at 6pm that day - the strip goes to S01E01 and the Friday Shuffle's round to S03E31, as the spec measured. Then on the branch, the same airing made with `makePin`: 164 of 164 positions continue exactly, and Hey Arnold's pool holds no S0E7. The Catalog page's review list for Hey Arnold is the same with and without the pinned airing.
- [ ] **Step 6:** Commit `Swaps: a pinned airing is never a place and never joins a pool`.

## Step 3 - The editor keeps pins and re-lays

### Task 3: Create Lineup and Regenerate keep pins; `relay`; what a re-lay did

**Files:**
- Modify: `web/directives/time-slots-schedule-editor.js` (+ its template `web/public/templates/time-slots-schedule-editor.html`), `src/pins.js`, `test/pins.js`

**Interfaces:**
- Consumes: Task 1's `calculateTimeSlots(..., pins)`; Task 2's `pinsAhead`, `slotPool`.
- Produces (editor): `doIt` sends `pinsAhead` of the lineup on air at that moment, or the `pins` it is given; the linker gains `relay({ programs, limit, backup, lineup, catalogState, pins }) -> Promise<{ programs, startTime, schedule, catalogOps }>` - Regenerate's path without opening the dialog or calling `onDone`. The dialog shows "Keeping your swaps and inserts: Thu Dec 24, 7:30pm Arnold's Christmas (Hey Arnold!), ..." when there are any.
- Produces (pure, in `src/pins.js`):
  - `slotAround({ schedule, at }) -> { start, end, showId }` - the slot occurrence holding `at`, by `slotProgress.slotAt` and the wall clock.
  - `fitAt({ programs, startTime, schedule, at, duration }) -> { slotEnd, space, overrun, runsInto: { start, program } | null }` - `space = slotEnd - at`, `overrun = max(0, at + duration - slotEnd)`, `runsInto` the program starting at `slotEnd`.
  - `relayEffects({ before, after, from, to, schedule, getShowData }) -> { movedAlong: [{ name, program, wasAt, nowAt }], late: [{ program, wasAt, nowAt }], backOnTime: ms | null, dropped: [{ start, program }] }` - `before`/`after` are `{ programs, startTime }`. Matched by file key: the same file in `after` within 3 hours later is `late` (more than `SLACK` later), further is `movedAlong` (one entry per position, its first); `dropped` is `before`'s airings from `from` with no position (`airings`' `key === null`), no `pin`, not a repeat, and not in `after` within 2 s.
  - `sayFit(...)`, `sayEffects(...)`, `sayDropped(...)`, `sayFirstSwap()` - the dialog's sentences, as in the spec: "Arnold's Christmas runs 24:06. The space is 30:00 - Best Man / Cool Party and the 7:22 of Flex after it. It fits: 5:54 of Flex after it, and Are You Afraid of the Dark? starts at 8:00." / "Best Man / Cool Party airs Mon Dec 28, 6:30pm, and Hey Arnold!'s later airings move one along." / "Runs 14:09 past 8:30, into Codename: Kids Next Door." / "This also drops what was placed in the list by hand: Thu Oct 15, 9:14pm NEXT - SGC2C (0:10)." / "Swapping re-makes the lineup from your Time Slots schedule, as Create Lineup does, so anything placed in the list by hand - bumpers, promos, episodes inserted from the library - is dropped." followed by the dropped list or "Nothing placed by hand from now on would be lost."
- [ ] **Step 1: Write the failing tests** in `test/pins.js`, on fixtures from Task 1's generator: `fitAt: fits, with the space to the slot's end`; `fitAt: runs into the next slot by 14:09, naming it`; `relayEffects names the episode that moved along and where it airs now`; `relayEffects names the shows that ran late and when the schedule is back on time`; `relayEffects lists a hand-placed bumper the re-lay drops, and not the airings that moved along`; `the sentences read as the spec's examples` (each `say*` against its exact string).
- [ ] **Step 2:** Run - Expected: failures.
- [ ] **Step 3:** Implement `src/pins.js`'s additions, then the editor's `doIt`, `relay` and the keeping note.
- [ ] **Step 4:** `npm test` - Expected: all pass. `npm run build`.
- [ ] **Step 5: Proof:** on the copy, `relayEffects` of Step 1's channel 2 re-lay says "Best Man / Cool Party airs Mon Dec 28, 6:30pm"; with a 10-second NEXT clip hand-inserted the old way into channel 1's copy, the dropped list names it, and on the real lineups it is empty. Live, on the preview: channel 2's copy with a pin put in the file by script, Time Slots, Create Lineup, Update Channel - the dialog names the pin it keeps, the saved file has it at its time with 5:54 after it, 164 records, no errors.
- [ ] **Step 6:** Commit `Swaps: Create Lineup keeps pins, and the editor can re-lay`.

## Step 4 - Swap, for Halloween

### Task 4: Go to, Swap, the fit and the choices, pinned rows, undo

**Files:**
- Create: `web/directives/airing-swap.js`, `web/public/templates/airing-swap.html` (register `airingSwap` in `web/app.js`)
- Modify: `web/directives/channel-config.js`, `web/public/templates/channel-config.html`, `src/pins.js`, `test/pins.js`

**Interfaces:**
- Consumes: Task 3's `relay`, `fitAt`, `relayEffects`, `say*`; Task 2's `makePin`, `pinsAhead`, `label`; `catalogReader.read(shows)` (`web/services/show-catalog.js`), `dizquetv.getAllShowsInfo()` / `getShow(id)` with `showCatalog.fromCustom`, `showCatalog.holidayOf`.
- Produces (pure): `airingAt({ programs, startTime, at }) -> { index, start, program } | null` - the airing on at an instant, round the loop (Go to; the first of two on the fall-back night).
- Produces (editor): `airingSwap` directive, `scope: { channel, index, mode, relay, catalogState, onDone }`, `mode` `'swap'` (Task 5 adds `'insert'`). `onDone(result | null)` hands the chosen re-lay to `channel-config`, which applies it as `onTimeSlotsDone` does.

Behaviour:
- **Go to** above the programming list: a date and a time; scrolls to `airingAt` and marks that row. Shown only with a Time Slots schedule (`channel.scheduleBackup`).
- On every airing row (not Flex) of such a channel, **Swap…** (`fa-exchange-alt`). A pinned row shows `fa-thumbtack`, titled "Pinned to Thu Dec 24, 7:30pm, in place of Best Man / Cool Party - kept by Create Lineup until it airs". Above the list, "Your swaps and inserts still to air (N)", each a Go to link.
- The dialog: the airing, its time and the space ("Thu Dec 24, 7:30pm - Hey Arnold! S03E23 Best Man / Cool Party, 22:38, then 7:22 of Flex"); a picker with a filter box - **This show** (its catalog read through `catalogReader`, specials included, by season, likely holiday episodes marked with their holiday), **Other shows on this channel** (one chosen, then read), **Custom shows** (one chosen, then its items); each item's length and "fits" or "runs 14:09 over".
- On a pick: re-lay with the new pin at `then: 'take'`; when it fits, `sayFit` and `sayEffects` and **Swap**. When it runs into the next slot, re-lay at `'late'` too and show both, **Take over the 8:30 slot** and **Run late**, each with its `sayEffects`, and **Pick something else**. A pick that starts inside another pin is refused, naming that pin.
- Before applying, when the lineup has no pins yet or `relayEffects(...).dropped` isn't empty: `sayFirstSwap()` with `sayDropped`, and **Go ahead** / **Cancel**.
- Deleting a pinned row asks "Undo this swap? The slot's own programming comes back." and re-lays without it.
- Each re-lay shows "Working it out..." and how long it took is logged to the console, for the proof.

- [ ] **Step 1: Write the failing tests** in `test/pins.js`: `airingAt finds the airing on at an instant, round the loop`; `...and the first of the two on the fall-back night`.
- [ ] **Step 2:** Run - Expected: failures.
- [ ] **Step 3:** Implement `airingAt`, then the directive and the channel page.
- [ ] **Step 4:** `npm test` - Expected: all pass. `npm run build`; restart the preview; reload the tab.
- [ ] **Step 5: Proof, live on the preview** (a fresh full copy): channel 3 - Go to Sat Oct 31 4:00pm, Swap, This show, "A Hero for Halloween": "It fits: 7:30 of Flex after it, and Lizzie McGuire starts at 4:30", "There's Something about Rene airs Sun Nov 1, 4:30pm..."; the first-swap note says nothing placed by hand would be lost; Swap, Update Channel. The saved file, checked by script: the pin at Oct 31 4:00pm with 7:30 of Flex after it, Rene Sun Nov 1 4:30pm, 155 of 155 positions continue, over 300 days only The Proud Family changes. Channel 1's 'Twas the Fight Before Christmas shows both choices with the spec's times; Run late applied and saved. Deleting the Halloween row undoes it: the saved lineup is Step 1's no-pin lineup again. Re-lay time per channel recorded. No console or server errors.
- [ ] **Step 6:** Commit `Swaps: swap an airing from the Programming tab`.

### Task 4b: A re-lay leaves the program on air alone (Ron, Oct 11, at the checkpoint)

Every re-lay - and Create Lineup, which takes the same path - keeps the program on air, or the one whose break is on air, exactly where it is, and re-makes the lineup only after it ends: it counts as aired, and the rest of its slot gets only what fits whole. Before, the program on air started again from its beginning and its show's later airings moved one along; and during a break, the slot's next episode went in at once, late.

**Files:** `src/services/time-slots-service.js` (`carry`), `src/api.js`, `web/services/dizquetv.js`, `src/slot-progress.js` (`planProgress({ placesFrom })`), `src/pins.js` (`carryAt`), `web/directives/time-slots-schedule-editor.js` (`doIt`), `scripts/progress-check.js`; tests in `test/pins-generator.js`, `test/slot-progress.js`, `test/pins.js`.

**Interfaces:** `pins.carryAt({ programs, startTime, now }) -> { start, program } | null` - the last program started at or before `now`, within a day; `timeSlotsService(programs, schedule, history, pins, carry)` - the lineup holds `carry.program` at `carry.start` (when at or after the generator's period start) and continues from its end as after a run-late pin; `planProgress({ ..., placesFrom })` - places read from `placesFrom` (the carried program's end) instead of `now`. A carried pinned airing keeps its pin and is left out of the pins sent.

- [ ] Failing tests: the generator carries a program on air at its real start and its slot's next episode waits; during a break, nothing starts before the next slot; a carried pin keeps its mark; `planProgress` reads places from `placesFrom`; `carryAt` on air, in a break, and none within a day.
- [ ] Implement; `npm test`.
- [ ] Proof on a copy: channel 3 regenerated Sun Oct 11 10pm, mid "The Jim Henson Hour": with the rule, Henson's airings continue (none of the 43 moves), and the lineup from 9:35pm is the saved one; at a break; channels 1-3 with no pins at three moments against `blocks`: differences only around the moment of the run.
- [ ] Random Slots doesn't share the path: Known issue.

**Halloween checkpoint.** A fresh review of Steps 1-4 (Opus 5.5), its fixes each with a test that failed first; then Steps 1-4 can merge into `blocks`, when Ron says. The server's generator changes, so the bundle is rebuilt and 18000 restarted together - Ron's to restart. Ron's first swap on a channel is also its first regeneration with the new code: measured, nothing changes on channels 1 and 2 for the year, and on channel 3 nothing before Apr 3, 2027.

## Step 5 - Insert

### Task 5: Insert after, a break where it fits, the library and the Catalog page's holiday episodes

**Files:**
- Modify: `web/directives/airing-swap.js` and its template, `web/directives/plex-library.js` and `web/public/templates/plex-library.html` (a one-item mode), `web/directives/channel-config.js` and its template, `src/pins.js`, `test/pins.js`

**Interfaces:**
- Produces (pure): `breaksThatFit({ programs, startTime, near, within, duration }) -> [{ after: { start, program }, start, length }]` - Flex runs after a program, `length >= duration`, starting within `within` ms of `near`, nearest first, at most 5.
- Produces (editor): `mode: 'insert'` - the pin at the airing's end, `kind: 'insert'`; the space is `fitAt`'s, and the break after the airing is named. Too long: **Run late** (first, recommended for inserts), **Take over the 6:30 slot**, **Put it in a break where it fits** (the `breaksThatFit` list, each a click that moves the insert there), **Pick something else**. The picker gains **Holiday episodes** (`showCatalog.byHoliday` of the catalog state, each found in its show's catalog read) and **From the library…** (`plex-library` with `pick-one`: the insert-point choice hidden, Done hands back the one selected item).
- [ ] **Step 1: Write the failing tests:** `breaksThatFit lists the nearest breaks long enough, nearest first`; `...none when nothing is long enough`; `sayFit for an insert 11 seconds too long names the break and the show after it`.
- [ ] **Step 2:** Run - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`; build; restart; reload.
- [ ] **Step 5: Proof, live:** channel 3, Thu Dec 24, Insert after Sister, Sister: the Silly Symphony "The Night Before Christmas (1933)" - "11 seconds too long"; Run late shows That's So Raven at 6:30:10; the breaks that fit list "after Boy Meets World, 7:21pm, 8:52"; inserted there, saved: 0:58 of Flex, The Jersey at 7:30. On the copy, The Proud Family reviewed on its Catalog page with "A Hero for Halloween" left out as Holiday: the picker's Holiday episodes lists it under Halloween. One episode picked from the library and inserted. No errors.
- [ ] **Step 6:** Commit `Swaps: insert after an airing, in a break where it fits`.

## Step 6 - Delete

### Task 6: Deleting an airing on a Time Slots channel

**Files:**
- Modify: `web/directives/channel-config.js` (`removeItem`, `finishDelete`), `web/public/templates/channel-config.html` (the delete prompt), `src/pins.js`, `test/pins.js`

**Interfaces:**
- Consumes: Task 2's `removalPin`; Task 3's `relay`, `relayEffects`.
- Produces (pure): `sayRemoval({ programs, startTime, index, schedule }) -> { flexMs, from, to, text }` - the Flex run the removal leaves; `text` "Leaves 30:00 of Flex, 7:30-8:00pm." The prompt says it, and offers **Swap it instead** beside **Remove this airing only**, when the airing is longer than 2 minutes.
- Behaviour, with a Time Slots schedule: **Remove this airing only** re-lays with `removalPin` (kept Flex; its episode airs at its show's next slot, said by `sayEffects`); **Holiday** and **Never air** queue the never-air entry as now and re-lay with no pin, so the slot airs the show's next episode. Without a schedule, delete works as now.
- [ ] **Step 1: Write the failing tests:** `sayRemoval: a 22:38 airing with 7:22 of Flex leaves 30:00, 7:30-8:00pm`; `...a 10-second clip, no offer of Swap`.
- [ ] **Step 2:** Run - Expected: failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`; build; restart; reload.
- [ ] **Step 5: Proof, live:** channel 2, Thu Dec 24 7:30pm Best Man / Cool Party - the prompt says "Leaves 30:00 of Flex, 7:30-8:00pm" and offers Swap; Remove this airing only, saved: kept Flex at its time, Best Man Mon Dec 28, and Create Lineup run again keeps it. An airing of "Madeline's Christmas" in channel 3's rotation, deleted as Holiday: no gap, Madeline's next episode in its place, the episode on the never-air list after Update Channel. No errors.
- [ ] **Step 7:** Commit `Swaps: deleting an airing keeps the times`.

## Step 7 - The Time Slots dialog knows about pins

### Task 7: Next-airing times skip pinned slots; a pin in a changed slot is named

**Files:**
- Modify: `src/episode-start.js` (`firstAiring`, `plan`), `web/directives/time-slots-schedule-editor.js` and its template, `src/pins.js`
- Test: `test/episode-start.js`, `test/pins.js`

**Interfaces:**
- Produces: `firstAiring({ slots, schedule, now, pins })` - an occurrence a pin takes (its start within a pin, unless the pin is `late` and ends inside it, when the time is the pin's end) is skipped; `plan(...)` passes `pins` through.
- Produces (pure): `pinNotes({ pins, schedule }) -> [{ pin, text }]` - "Arnold's Christmas, Thu Dec 24, 7:30pm: that slot is Rocket Power's now, not Hey Arnold!'s." for a pin whose slot's show differs from `pin.slotShow`.
- [ ] **Step 1: Write the failing tests:** `firstAiring skips a slot a pin takes`; `...a late pin's slot airs when the pin ends`; `pinNotes names a pin now in another show's slot`; `...and nothing when the slot is unchanged`.
- [ ] **Step 2:** Run - Expected: failures.
- [ ] **Step 3:** Implement; the dialog shows `pinNotes` under the keeping note.
- [ ] **Step 4:** `npm test`; build; reload.
- [ ] **Step 5: Proof:** in Node, channel 2 with the Dec 24 pin, the plan at Thu Dec 24 7:00am: Hey Arnold!'s strip row reads "Next: S03E23 Best Man / Cool Party . Mon Dec 28, 6:30pm". Live: Thursday 7:30pm changed to another show in the dialog names the pin.
- [ ] **Step 6:** Commit `Swaps: the Time Slots dialog skips pinned slots and names moved ones`.

## Step 8 - Final

### Task 8: Final review and the record

- [ ] **Step 1:** A fresh review of the whole branch (Opus 5.5): every fix with a test that failed first.
- [ ] **Step 2:** Every step's proof re-run on the final code, on a fresh copy, with the snapshot time.
- [ ] **Step 3:** NOTES.md: the build record under "Swaps, inserts and Flex that keeps time", the two Library management lines and the 1.0 line ticked with what shipped; "Full catalogs: smaller things left for later"'s note on the delete prompt's "As before" brought up to date.
- [ ] **Step 4:** Commit `Docs: record swaps and inserts`; merge into `blocks` when Ron says, rebuilding the bundle and restarting 18000 together (Ron's).
