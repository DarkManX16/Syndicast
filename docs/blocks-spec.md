# Blocks — Design Spec

Syndicast · `blocks` branch · Status: stages 1-4 built; stage 5 (transitions) designed Oct 1, 2026, steps 1-4 built (situations, names, plans, playing them through the cursor)

## Summary

Blocks make a channel's filler change automatically by time of day and day of week, and eventually carry their own transition bumpers — so a channel runs like a real broadcast day without anyone swapping Flex settings by hand.

The design is an **overlay**. Day-parts and blocks are a wall-clock schedule of filler rules, resolved at the moment filler is picked. They never enter the generated lineup and never change how slots schedule shows.

## Decisions

Settled. Revisit only with new evidence.

| Decision | Why |
|---|---|
| Overlay, not containers | Filler is chosen at playback, not generation. An overlay needs one call site, no migration, no regeneration, and works on existing lineups. Containers would mean rewriting slot window derivation on top of the DST fix, enforcing boundaries against overrun, and rebuilding the slot editor — a scheduling redesign nothing requires. |
| Every rule fully specifies its mix | In every real example, an "added" block also reweights or drops base lists. Inheriting the base would produce the wrong mix. |
| Two tiers: day-parts, and blocks on top | Matches how the channels are actually described — an overall Flex, with blocks over it. |
| Breaks take context from their neighbours | The lineup can't say which slot owns a gap; the programs on either side can. Unlike a clock rule, this stays correct when a show overruns. |
| 12am starts the next day | Calendar days. Saturday 1am belongs to Saturday. |
| DST shift is an option on a time field | Only rare boundaries need it. Everything else stays at the wall-clock time entered. |
| Not on on-demand channels | On-demand deliberately severs the lineup from wall clock. |
| Transitions go inside breaks | The between-items interlude seam sits outside time accounting; bumpers there would drift the channel ~7 minutes a day. |
| Transition templates are per day-part/block, default empty | Break shapes differ by block, and most breaks are one bumper or none. |
| Transitions attach to the context, shaped around the break | The lineup is regenerated and has hundreds of slots; a per-item attachment would be redone each time. Whether the show or the block changed decides the sequence, and that is computed, not entered. |
| A clip names the shows it is about | Channel 1 has 281 distinct adjacent show pairs a week. Tags on clips, proposed from titles and fixed once on a review screen, scale; per-pair rules do not. |
| Breaks bend, transition steps never | Flex is what absorbs a stream's lateness (stage 4). Steps play whole and in order; a dropped break keeps them. |

## Concepts

### Day-part

The base filler for a stretch of the week.

- **Name**, **mix** (filler lists, each with weight and cooldown), optional **guide name**, and later a **transition template**.
- **Starts**: one or more `(days, time)` entries, each with an optional *shift with daylight saving* flag. One day-part can start on several days — "Weekday Day" starts Mon–Fri at 6:00am.
- All starts across all day-parts form one continuous weekly chain. Each start runs until the next start in the week, wrapping at week's end. There are no end times, so gaps and overlaps are impossible.
- A channel with no day-parts uses its existing Flex tab exactly as today.
- Only the filler mix is time-scoped. Channel Fallback and "hide watermark during filler" stay channel-wide.

### Block

A named stretch of programming that overrides the day-part while it airs.

- **Name**, **mix**, optional **guide name**, and later a **transition template**.
- **Airings**: one or more `(days, start, end)` entries. One block can air many times — weekday Toonami and the Saturday midnight run are one Toonami block with two airings, so the mix is edited in one place.
- An airing whose end is earlier than its start crosses midnight and belongs to its start day.
- Airings of different blocks may not overlap on the same day. The editor validates this.

### Context

At any moment, the **context** is the block airing covering it; otherwise the day-part covering it; otherwise the channel's default Flex.

## Resolution rules

### A program's context

The context covering the program's **start time**. A program that overruns keeps its starting context — boundaries never cut a show short.

### Which mix fills a break

For a break between program **P** (ending) and program **N** (starting):

- **Same context** → that context's mix.
- **Different context (a boundary)** → the **incoming** context's mix.

This reproduces the real channels:

- The break before Toonami's first show plays Toonami filler — "the filler starts after the 2:30 show."
- The break after Toonami's last show plays the day-part's filler — "after the 4:30 show, the Flex switches back."
- **Set each boundary at the time the new programming actually starts.** The break before it takes the new mix automatically, so the old workaround of setting a boundary to the start of the preceding show is no longer needed.

A break with no program neighbour — the start of a lineup, or an all-Flex channel — resolves from the clock.

### Daylight saving

A time marked *shift with daylight saving* stays fixed in standard time, so it reads an hour later on the wall clock in summer. The UI never says "standard time"; it shows the result — *7:00 PM in winter, 8:00 PM in summer.* All other times stay at the wall-clock time entered, as the DST fix on `main` already guarantees.

## Stages

Each stage ships and is useful on its own. Model per the Model guide in NOTES.md.

### Stage 1 — Day-parts

Replaces the single channel Flex with a time-scoped chain. Solves Nick Picks outright, plus Adult Swim and CN City Day/Night.

- **Core (Opus 5):** the resolver. Pass `t0` and `programIndex` into `createLineup` at `video.js:306` and resolve the mix there. The neighbour-context break rule, over day-part contexts. The daylight-saving option. Persistence.
- **UI (Sonnet 5):** a day-part list in the channel editor, reusing the existing Flex list/weight/cooldown editor for each mix. A start-time editor with the daylight-saving toggle and computed times. A simple weekly strip showing which day-part covers when. A "convert to day-parts" action that turns the channel's current Flex into a single all-week day-part as a starting point.
- Channels without day-parts are untouched.

The stored shape, which the core reads and the UI writes. It is an optional field
on the channel, so there is nothing to migrate: absent or empty means the channel
uses its Flex tab exactly as before.

```js
channel.dayParts = [{
  id, name,
  guideName,                                        // stored, wired up in stage 2
  fillerCollections: [ { id, weight, cooldown } ],  // same shape as channel.fillerCollections
  starts: [ { days: [1,2,3,4,5], time: 21600000, shiftWithDst: false } ]
}]
```

`days` are 0 (Sunday) to 6 and `time` is milliseconds from local midnight.
`fillerRepeatCooldown` is **not** part of a mix: it is a per-clip cooldown, and
clip cooldowns stay channel-wide and shared across contexts.

`src/day-parts.js` is pure and does no I/O, so the editor can call
`effectiveStartTime(start, instant)` for its computed times rather than keeping a
second copy of the daylight-saving arithmetic. `src/dao/channel-db.js` warns on
malformed or colliding starts at save; it rewrites nothing.

### Stage 2 — Blocks with airings

Adds Toonami, Miguzi, Cartoon Cartoons Friday, Cartoon Theatre, and the midnight run.

- **Core (Opus 5):** block airings in the resolver, extending the neighbour-context break rule to block contexts, and per-context guide names (generalising `guideFlexPlaceholder`).
- **UI (Sonnet 5):** a block editor — name, mix, airings — with overlap validation.

### Stage 3 — Block Schedule Manager (Sonnet 5)

A weekly calendar like the one kept by hand today: day-parts as background bands, blocks as coloured regions, slots drawn inside by their times. Clicking a block edits it; clicking a slot opens the existing slot editor. Editing a block's shows goes through the slot filter scoped to the block's window. Blocks never own slots.

### Stage 4 — Short-clip bug (Opus 5)

Clips under ~20 seconds next to Flex repeat about three times or get skipped. Transitions are exactly that, so this is a hard prerequisite for stage 5. See NOTES.md.

Fixed by a lineup cursor per viewer: a stream plays the next entry in the lineup, each program from its start, and only breaks stretch or shrink to bring it back to the clock. A break that has too little time left is dropped, and the stream's lateness carries on to the next break.

### Stage 5 — Transitions (designed Oct 1, 2026 on Fable 5.1; Sonnet 5 builds)

Each day-part and block gets a set of transition sequences. **Every sequence
defaults to empty**, so an unconfigured break is just commercials and no saved
channel changes until someone adds a step.

Designed from channel 1's real lineup, not from the examples alone. In the
week of Oct 18, 2026 it has 442 breaks: 117 between two episodes of one show,
297 between different shows, 28 at a day-part or block boundary. (Measured on
the Oct 1 file this was 113 / 301 / 28. The lineup did not change; the
day-part and block boundaries did, between the Oct 1 and Oct 2 backups - CCN
6:00 to 6:30, Toonami 2:50pm to 3:00pm, Miguzi 2:30pm and 2:45pm to 3:00pm,
Sunday Adult Swim 10:00pm to 10:30pm, among others. Moving a boundary moves
which break sits on it: the same 442 breaks fall at the same times, but 26 of
them changed situation. 13 became boundaries and 13 stopped being one, so 28
either way, and the 4 that stopped being a boundary were all breaks inside one
show (I Am Weasel before Toonami, and a custom show's two halves before
Miguzi), while the 13 that became one were all different-show breaks. The
442 and the 281 distinct pairs depend only on the lineup, which is unchanged,
so they hold whatever the boundaries are; the split moves with them.) The four
NEXT promos it carries today sit in the lineup as ordinary items — show →
15s NEXT promo → Flex → 10s NEXT bumper → show — which is exactly the shape a
between-shows sequence produces, so the design is checked against them below.

#### Situations and assembly

A sequence belongs to a **situation** on a context. Each situation has two
ordered lists of steps: **out** (before the Flex) and **in** (after it).
Nothing is fixed by role: an Up Next can sit on either side.

| Situation | Fires when |
|---|---|
| **Leaving** | A boundary break out of this context |
| **Entering** | A boundary break into this context |
| **Between episodes** | Inside this context; the show after the break is the show before it |
| **Between shows** | Inside this context; a different show follows |

A break is the run of adjacent Flex entries between program **P** and program
**N**. P's context is resolved at P's start, N's at N's start, by
`resolveContext` as everywhere else. "The same show" means the same show key:
`custom.<id>` for an item of a custom show, else `tv.<showTitle>`, else
`movie.<title>` — the key the slot editor already uses, so a custom show
counts as one show, which is what makes a block of Looney Tunes shorts one
show and not thirty.

- Same context, same show: `betweenEpisodes.out` → Flex → `betweenEpisodes.in`
- Same context, different show: `betweenShows.out` → Flex → `betweenShows.in`
- Boundary: `P.leaving.out` → `N.entering.out` → Flex (N's mix) → `P.leaving.in` → `N.entering.in`
- No program on one side (the start of a lineup): that side contributes nothing.
- Two programs with no Flex between them get no sequence. Sequences live in breaks.

A sequence is chosen per break, never per Flex entry: the out steps attach to
the first Flex entry of the run and the in steps to the last, so a break the
generator left as two Flex entries still gets one sequence.

#### Steps

A step says which clips it may draw from and how it chooses one:

```js
{ id, kind: 'list',
  listId,                            // the filler list it draws from
  match: 'any' | 'show' | 'pair',    // any clip; a clip naming the keyed show; a clip naming now→then
  keyedOn: 'now' | 'next' | 'later', // which show a 'show' step must name (see below)
  fallbackListId: null,              // when nothing names the show: null skips the step, a list plays one from it
  onlyIfNoMatch: null,               // null, or the id of another step in this sequence: play only if that one found no clip
  days: null,                        // null, or the weekdays it plays on, 0 = Sunday (step 3b)
  chance: null }                     // null, or a whole percent 1-99 it plays at (step 3b)
```

A filler list may also carry `clipsFeatureShows: true` (step 3b, below). Every
one of these three is off when absent, so a channel, list or plan saved before
step 3b reads, and plays, exactly as it did.

- **`match: 'any'`** is the fixed-list step: an ident, a block bumper, a
  "we'll be right back".
- **`match: 'show'`** is the per-show step. The clip must name the keyed
  show: `next` for an Up Next or a show intro, `now` for a "that was" card or
  a show's own closing bumper. A per-series bumper is simply a `show` step
  whose fallback is *skip*: "DBZ intro" before Dragon Ball Z and nothing before
  anyone else. There are no per-show sequences; this step is what "per
  series" means.
- **`match: 'pair'`** is the Now/Then step. It wants a clip naming both P and
  N in that order. If none exists it tries a clip naming only N (a plain Up
  Next for the same show), then the fallback list, then skips.
- **A clip naming two shows, in a step keyed on `next`,** means "coming up:
  these two, in this order". It plays only when the next show is the first
  name and the show after it is the second: "Up Next Bumper (All in the
  family-The Jeffersons)" plays before All in the Family when The Jeffersons
  follows it, and never when something else does. "The show after" is the first
  program after the next show's own run that is neither Flex nor another
  episode of that show. A **`pair`** step is the only place two names read as
  now → then, and a step keyed on `now` never plays a two-name clip. (Settled
  at step 3, and it is what this spec's own "Now/Then (Grim / Foster's)"
  acceptance row needs: that clip plays before Grim, so it cannot be a clip
  naming the show that ended and the one starting.) Two-name clips and
  one-name clips share one pool; the longest-idle plays.
- **`onlyIfNoMatch: <step id>`** marks a step to play only when the step it
  names found no clip. The Nick at Nite sequence: an Up Next step, then a WBRB
  step out and a BTTS step in, both marked with the Up Next step's id, so they
  play only for a show that has no Up Next bumper. A step *names* the one it
  watches, rather than reacting to "any other step", because sequences carry
  optional steps ahead of the one that matters: with a Next Promos step before
  the Up Next bumper, and most shows having no promo, "any step found nothing"
  would play WBRB and BTTS even when the Up Next bumper played. The rules:
  - It watches a step of its own sequence, meaning the same context's same
    situation, out and in together. A boundary joins two contexts' sequences;
    a step never watches across them.
  - "Found no clip" is what the step ended with: a clip from its **fallback
    list counts as a match**, so a watched step that fell back to a generic
    bumper keeps the marked steps out. A step skipped because its list is
    empty or missing found no clip.
  - The marked step is decided after every unmarked one, so where it sits in
    the sequence does not matter and the plan is complete before the out side
    plays. A step cannot watch itself, another marked step, a step that is not
    in the sequence or an id used twice in it: such a step is skipped, with a
    note and a warning at save, rather than guessed at.
- **`days`: only on these days (step 3b).** A step with `days` plays only when
  the break's local weekday is listed, 0 for Sunday as in day-parts and blocks.
  The break's day is the local day it *starts*, the moment the program before it
  ends, so a break that begins at 11:50pm Friday and runs into Saturday is a
  Friday break. A step left out by its day has found nothing, so a step marked
  `onlyIfNoMatch` on it plays; that is what lets one sign-on sit on the out side
  on Mondays and, as a second step, on the in side the rest of the week. An empty
  list is a mistake, not "every day": it plays on no day and is warned about at
  save, and so is anything that is not a list of whole numbers 0 to 6. Leave
  `days` off for every day.
- **`chance`: sometimes (step 3b).** A step with `chance` plays only some of the
  time, a whole percent from 1 to 99; unset and 100 mean always, and anything else
  (0, a fraction, a string) is a mistake: the step is skipped and warned about.
  The roll is **derived, not random**: a hash of the channel, the break's start
  and the step's id, in [0, 1), and the step plays when it is under the percent.
  A plan is dropped on every save and lost on a restart, and a re-rolled break
  could change what a half-watched break shows; derived, every build of one
  break, for every viewer, gets the same answer, while the same break one lineup
  cycle later (another start) gets its own, and two steps of one break roll
  apart. A step that loses its roll has found nothing, so "Up Next before the
  break sometimes, otherwise right before the show" is an Up Next step with a
  `chance` on the out side and an Up Next step on the in side marked
  `onlyIfNoMatch` on it: exactly one of them plays. Tests, and the plan-day
  script, may supply their own roll (`env.roll`).
- **`keyedOn: 'later'`** keys a step on the first program of this context's
  *next* airing or start, for Cartoon Theatre's "Next Time" — the one bumper
  in the examples that names neither neighbour. It is the last build step and
  may slip past 1.0; the field is reserved either way.

**Matching falls back rather than skipping.** A step tries its most specific
match, then the next, then its fallback list. A step with no fallback is the
spec's "optional" step. A step whose list is empty or missing is skipped with
one log line. The one thing never done is playing a clip that names a
different show: a clip plays only if every show it names is one the step is
keyed on. A general bumper in place of a specific one is fine; "Up Next:
Dexter's Lab" before Johnny Bravo is not.

Among the clips a step may use, the longest-idle plays first, read from the
same per-clip play times filler uses, so a show with three Up Nexts rotates
them. Cooldowns are a preference here, not a bar: the only clip that names
the show plays even if it played an hour ago. Step clips record playback like
filler, so filler's own rotation sees them too. Ties go to list order, so a
break always builds the same plan. A clip plays at most once in a plan: the in
step of a break whose out step took the only fitting clip falls through to its
fallback or skips, so the SGC2C promo and the SGC2C NEXT clip are two different
clips on either side of the Flex. The never-a-different-show rule holds for
every `match`, `any` included: `any` needs no name, but a clip that does name
a show must name one the step is keyed on. A clip whose `names` field is not
usable is never chosen.

**Lists whose clips feature shows (step 3b).** The never-a-different-show rule
suits a list of Up Next bumpers, and it is wrong for character bumpers: a Courage
or Johnny Bravo bumper features its show without announcing it, and is as good
before any show. A filler list can say so with the setting **"These clips feature
shows"** (`clipsFeatureShows`, set in the list editor, off by default). A step
drawing from such a list, as its list or as its fallback, tries in order:
(1) clips naming the show the step is keyed on, the pair where the step wants
one, as above; then (2) **any clip in the list**, named or not, a clip naming a
different show included, the longest-idle first. So a list like "CN City Bumpers
[DAY]" serves as the fallback for shows with no Up Next or promo, and as a
WBRB or BTTS between episodes, and when the next show has its own bumper there,
that one wins. A tier-2 clip is a match like any other: a step marked
`onlyIfNoMatch` on it stays out. Unchanged: a clip plays at most once in a plan,
a clip with an unusable `names` or no length is never chosen, and a list without
the setting keeps the rule above, a named clip never playing before a different
show. The setting belongs to the list, so it applies to every step that reads it.

**Room for a "generated" step.** `kind` is the extension point. After 1.0,
`{ kind: 'generated', template: 'up-next' | 'later-tonight' | 'tonight-on',
durationMs }` slots in beside `list` steps: the plan below carries each step
as `{ kind, durationMs, ... }` and the cursor's phase machine reads only
`durationMs`, so a generated step needs a renderer in `video.js` and nothing
in the cursor. The `now`/`next`/`later` lookups are the same ones its three
templates need.

#### Which shows a clip names (settles open question 1)

Pair and show steps need to know which show a clip is about. Nobody is going
to enter that per pair: channel 1 has 281 distinct adjacent pairs in a week,
222 of them seen once, and 293 across the whole 323-day lineup — a week *is*
the schedule, and the set is the size of the lineup, not of the examples.

So the mapping lives on the clip, not the step. Each clip in a filler list
may carry `names: [showKey]` or `names: [showKey, showKey]` (now, then). It is
proposed automatically and fixed on a review screen:

- **Proposal** matches the clip's title against the show keys of every
  channel's slots and programs: longest title first, case and punctuation
  folded, so "Adult Swim Promo - Cowboy Bebop [2003]" names Cowboy Bebop and
  "AcTN Big O Silhouette Intro" names The Big O. Two titles found in order
  make a pair - which is how the pair is *read* is up to the step: now → then
  in a `pair` step, "coming up, in this order" in one keyed on `next` (see
  Steps). A leading "The" is optional when the rest of the title is
  still two words or more, so "Powerpuff Girls Promo" names The Powerpuff
  Girls; a single word left (five letters or more) counts only when it stands
  alone as its own segment, so "Up Next Bumper (Jeffersons)" names The
  Jeffersons and "Jeffersons promo" does not. A trailing year in a Plex title
  ("ThunderCats (2011)") is optional too, and a program under a minute in a
  lineup is a clip, not a show. Titles like "[As] NEXT - SGC2C [2003]" match
  nothing on the first pass.
- **Review** is a table: clip, proposed show(s), a dropdown to fix it, and
  "none" for a clip that names no show. A one-time pass per list, redone only
  for new clips.
- **Learning**: when the user maps a clip, every word of its title that is
  not a show title becomes an alias for that show (`SGC2C` → Space Ghost
  Coast to Coast, `DBZ` → Dragon Ball Z, `Grim` → The Grim Adventures of
  Billy & Mandy) and the next proposal uses it. Not every word: a number, a
  structural word ("promo", "next"), a word that is part of a show title, and
  a word that clips naming a different show also use ("Adult", "Swim") are
  never learned, and a word that already means another show is left alone and
  reported. The review screen shows what would be learned before saving it.
  Aliases are stored once, in
  `<data>/show-aliases.json`, shared by every list and channel. There is no
  alias editor; the review screen is the alias editor.

Our stamp, against the two programs we took the idea from: the clip knows
what it is about, so one list serves every show and every pair, and the
schedule can be regenerated or a show swapped without touching a single
mapping.

#### Playing through the lineup cursor

Since stage 4 a viewer's stream follows a cursor and only breaks bend. A
break with a sequence becomes three phases, carried on the cursor:

```js
cursor = { ..., inBreak: true, phase: 'out' | 'flex' | 'in', step: k,
           plan: { out: [ {kind, key, durationMs, ...} ], in: [ ... ], runEnd } }
```

- **Entering the break from the previous program** (the cursor's normal
  path) resolves the situation, builds the plan once — clips chosen then, so
  every call of this break sees the same plan — and plays the out steps in
  order, from their start, however early or late the stream is.
- **Flex** then runs with time left = (break end − in-steps' total) − now.
  A late stream gets a shorter Flex, an early one a longer one, exactly as
  today. When less than `SLACK` + 1 is left, Flex ends.
- **In steps** play in order, then the next program from its start.
- **Breaks bend; transitions don't.** Shrinking a break shrinks its Flex.
  Dropping a break drops its Flex and still plays its steps; whatever
  lateness the steps add carries to the next break, as lateness does today.
  This replaces `lineup-cursor.js`'s rule that passes over a break with too
  little left for a clip: a break is now passed over only when it has no
  steps *and* too little left.
- **Tuning in without a cursor** (the clock path, and `/m3u8`) lands in a
  break by time: in the `in` phase when the time left is within the in steps'
  total plus `SLACK`, otherwise in `flex`. The out steps are in the past; a
  viewer who tunes in mid-break missed the Up Next, as on real TV. The
  random start inside a clip at tune-in applies to Flex only, never a step.
- **A viewer tuning in on the replay cache** inherits the item and its cursor
  as today, plan included, so two viewers 10 seconds apart see the same
  sequence.
- **The 60-second tolerance** is unchanged and measured at the Flex, where it
  always was: a stream further off than that falls back to the clock as now.
- A step's lineup item has `type: 'transition'`, so the channel detail page
  can say what it is; the player treats it as it treats a commercial.

`src/transitions.js` is a pure module like `day-parts.js`: situation of a
break, assembly, matching, plan. `lineup-cursor.js` grows the phases.
`createLineup` learns to subtract the in steps from a break's time left.
`video.js` serves a step like a filler clip. Nothing stored changes shape
except the new optional fields.

#### Stage 5, stage 6 and the roadmap lines

- **Stage 5** (between programs): "we'll be right back" and "back to the
  show" around a break between episodes; Up Next, idents, intros, host intros
  and show closers between shows; block sign-ons and sign-offs at boundaries;
  "Next Time" via `later`.
- **Stage 6** (inside an episode): the same WBRB and BTTS clips around a
  midroll. Stage 6 adds a fifth situation, **Midroll**, with the same step
  model and the same empty default, once chapter detection exists.
- **Slot filler positions (HEAD / PRE / MID / POST / TAIL)** are covered and
  the roadmap line folds into this stage. PRE and POST are the in and out
  steps of the between-* situations; HEAD and TAIL are Entering and Leaving
  when the stretch is a block, and between-shows when it is not; MID is
  stage 6. What positions would add that contexts don't is a per-slot
  override — this Monday 8pm slot, not the same show on Tuesday — and no real
  channel asks for one.
- **Sign-ons and sign-offs** are a Leaving sequence at the end of the
  broadcast day and an Entering sequence at its start, so that line folds in
  too. Left over, and not stage 5: an overnight stretch that should look
  off-air. The neighbour rule plays one mix through a long break (open
  question 2), so an "Off Air" day-part with an empty mix is never the
  context of the overnight break — its neighbours are the evening and morning
  shows. Revisit as its own small item: a break longer than some hours
  resolves per clip from the clock.
- **Generated Up Next bumpers** stay after 1.0, as the `generated` kind above.

#### Channel 1's NEXT promos

Nothing to migrate. The four items are hand inserts at the head of the lineup,
played once on Sep 30, 2026; the lineup cycles every 323 days, so they come
round again on Aug 19, 2027 at the earliest, after the point the lineup has to
be regenerated anyway, and Time Slots never produced them, so a regeneration
drops them. Until then they are ordinary programs the cursor plays once, from
their start.

To get the same shape from a sequence: put the NEXT clips in a filler list
("[As] NEXT promos"), run the review screen (the 15s "SGC2C NEXT promo" and
the 10s "NEXT - SGC2C" both learn the SGC2C alias from one fix), then on the
Adult Swim day-parts set *between shows* to
`out: [show step, keyed on next, from that list, skip if none]` and
`in: [the same]`. That reproduces show → NEXT → Flex → NEXT → show for every
Adult Swim break with a matching clip and does nothing for the rest.

#### Worked examples from the Nick channel

Real patterns from Ron's Nick channel, each a fixture row in
`test/blocks-acceptance.js` (and listed under Acceptance tests below). Each reads
in play order, out steps, Flex, in steps. A clip's name is the show it names, as
the review screen will have set it ("Up Next Bumper (Doug)" names Doug).

| Break | Plays | Built from |
|---|---|---|
| Hey Dude → Clarissa | Clarissa WBRB → commercials → Up Next (Clarissa) | Between shows: out, a `show` step keyed on `next` from the WBRB list; in, the same from the Up Next list |
| Clarissa → Doug, entering Nicktoons | Nicktoons Intro → commercials → Up Next (Doug) → Nick Bumper (Doug) | Nicktoons' Entering: out, an `any` step from the intro list; in, two `show` steps keyed on `next`, the Up Next list then the Nick Bumpers list |
| Hey Arnold → Are You Afraid of the Dark? | commercials → NEXT promo for the show | Between shows, in: a `show` step keyed on `next`, skip if none. A show with no promo gets none |
| Into Kenan & Kel | commercials → Nick Bumper → Back to the Show | Between shows, in: two `any` steps, each from a list of generic clips |
| Entering Nick at Nite | Tue-Sun: commercials → Up Next (The Cosby Show) (More) → Sign On, right before the first show. **Mon:** Sign On → commercials → Up Next (The Cosby Show) (More) | Entering: out, a Sign On step with `days: [1]`; in, the Up Next `show` step then a second Sign On step with `days: [0, 2, 3, 4, 5, 6]` |
| A show with no Up Next, on CN City | commercials → a character bumper for a different show. When the next show has a bumper of its own in the list, that one | Between shows, in: a `show` step keyed on `next` from the Up Next list, fallback "CN City Bumpers [DAY]", a list set to **These clips feature shows**. The same list serves as WBRB and BTTS between episodes |

Two more the options above make possible: **Up Next before the break sometimes,
otherwise right before the show** (an Up Next step at `chance: 50` out, the same
Up Next marked `onlyIfNoMatch` on it in), and **a step that skips a day**, whose
absence the marked step covers.

#### Editor

Our design principle, applied: we attach transitions to the **context** the viewer is
in — the day-part or block — because the lineup is regenerated, channel 1 has
335 slots and 137 shows a week, and a per-item attachment would be redone
each time. We shape them **around the break**, out → Flex → in, in four
situations, because whether the show changed and whether the block changed
is what decides a WBRB from an Up Next from a sign-off, and that decision is
made for the user. And the clip carries the show it names, so there is one
list, not one per show.

- **On each day-part and block card**, under Mix, a **Transitions** section:
  four rows (Leaving, Entering, Between episodes, Between shows). Each row
  reads left to right as the break will play: `[+ step] … → Flex → … [+ step]`.
  A step is a chip — list name, then "any", "names next show", "names
  now → then", and "skip" or the fallback list — that opens inline to edit.
  Empty rows read "commercials only".
- **"Preview on this week's lineup"** under the section walks the channel's
  saved programs (the editor already loads them) and lists the next few breaks
  of each situation with the plan they would get — "Fri 2:50pm, Ed, Edd n
  Eddy → Dragon Ball Z: Toonami bumper → Flex 4:12 → DBZ intro" — so a
  sequence is checked against what will actually air, not against an example.
  The clip picks in the preview are the longest-idle ones at preview time;
  the live pick may differ.
- **In the filler list editor**, a **Names** column per clip and a
  "Match shows" button that opens the review screen above, and the **These
  clips feature shows** checkbox (built at step 3b).
- The on-demand warning the Blocks tab shows applies unchanged.

**How the lists are laid out.** One Up Next list per block or era, holding
every show's bumpers - each clip names its show, so a `show` step picks the
right one. That era's generic bumpers go in their own list, as the Up Next
step's fallback. Back 2 Back and More bumpers go in their own list, for the
Between episodes situation.

#### Build order for Sonnet 5

One session each, each verified on a copy of the real data folder (never the
live one, and never the server on port 18000). Steps 4 and 7 need a TiviMate
preview from Ron; the rest are verified by tests and scripts against channel 1.

1. **Situations and assembly** — `src/transitions.js`: show keys, P and N
   with their contexts, the four situations, the run of Flex entries, the
   stored shape and its defaults, `warnAboutTransitions` in `channel-db.js`
   next to `warnAboutBlocks`. Tests in `test/transitions.js` on fixtures.
   Real-data check: a script over channel 1's week of Oct 18 reports 442
   breaks as 117 / 297 / 28, the numbers above, for channel 1 as it stood on
   Oct 2, 2026. Re-measure before trusting them after any boundary edit.
2. **Names and the matcher** — `names` on filler clips, `src/show-match.js`
   (pure: titles and aliases in, proposals out), `<data>/show-aliases.json`,
   `GET /api/filler/:id/match` and the alias save. Tests on fixtures. Real-data
   check: the matcher over Ron's ten lists, reporting what it proposes for
   the Adult Swim, Toonami and AcTN lists and what it leaves unnamed.
3. **Plans** — matching and fallback, longest-idle choice, the never-a-
   different-show rule, without `later` for now. A step can also be marked
   *only when the step it names found no match* (`onlyIfNoMatch`): Nick at
   Nite plays a WBRB clip on the way out and a BTTS clip on the way in only
   when the Up Next step finds no bumper for the next show. The plan is built
   once on entry, so it knows the outcome before the out side plays. The
   spec's stage 5 acceptance rows go into `test/blocks-acceptance.js`'s `ROWS`
   as `planRow(5, …)`, written as fixtures with their own day-parts, blocks and
   lineups, not against channel 1's block times. Real-data check: plans for one
   day of channel 1 with a test sequence on Adult Swim, printed break by break
   (`scripts/transitions-plan-day.js`). **Built Oct 3, 2026**; see NOTES.md.
3b. **Days, chance and lists that feature shows** — three options so breaks can be
   laid out freely, each off by default so nothing saved changes: a step's `days`
   (only on these weekdays, by the break's local day), its `chance` (a whole
   percent, rolled once per break from a hash of the channel, the break and the
   step, so every viewer and every rebuild agrees), and a filler list's
   `clipsFeatureShows` (a clip naming any show may play before any show, after
   the clips naming the keyed one). `buildPlan` learns all three; a step skipped
   by day or chance counts as having found nothing, for `onlyIfNoMatch`;
   `warnAboutTransitions` warns on a bad `days` or `chance` from the same two
   functions the builder uses; the list editor gets the checkbox. Built before
   step 5, so the card editor is written once with these in it. The Nick channel's
   patterns above are the fixture rows. **Built Oct 3, 2026**; see NOTES.md.
4. **The cursor phases** — `lineup-cursor.js`, `createLineup`'s time left,
   `video.js` serving steps, the clock-path tune-in rule, `type: 'transition'`.
   `test/lineup-cursor.js`'s simulated viewer gains steps: every step once,
   Flex shrinks first, a dropped break keeps its steps; `test/stream-cursor.js`
   follows a plan through the real router. **TiviMate preview**: a scratch
   server from a worktree on a copy of `.dizquetv-dev` as stage 4 was done,
   with the compressed 5-15s channels from stage 4 given sequences, and
   channel 1's copy with the Adult Swim NEXT sequence above. **Built Oct 3,
   2026, confirmed in TiviMate**; see NOTES.md. A tune-in lands on the in step
   on the air, and one plan per break is shared by every viewer.
5. **The card editor** — the Transitions section on both cards (a step's chip
   also carries "only on these days" as seven day toggles and "sometimes" as a
   percent box, 1 to 99, both off by default and both shown on the chip, since
   they decide whether it plays; the mark offers the other steps of the same
   row, as before), load-time
   defaults and save-time cleanup beside the day-part ones in
   `channel-config.js`, the preview on this week's lineup. In the channel's
   programming list, each Flex row shows a one-line tag naming its planned
   sequence (for example "Up Next · Full House" or "WBRB / BTTS"), without
   changing the row's height. Verified by hand on the dev fixture and a copy
   of channel 1, with screenshots.
6. **The review screen** — the Names column and "Match shows" in the filler
   editor, writing `names` and aliases. Verified on Ron's lists: the SGC2C
   case above learns from one fix.
7. **End to end on channel 1** — the Adult Swim NEXT sequence and one Toonami
   boundary configured on the copy, a day walked by script, then a
   **TiviMate preview** of two real breaks. Then the roadmap: tick the
   transition line, fold the slot-positions and sign-on lines into it, and
   record the off-air leftover.
8. **`keyedOn: 'later'`** and the Cartoon Theatre "Next Time" row — last, and
   only once 1-7 are in.

### Stage 6 — Midrolls

Breaks inside a program. Depends on chapter/segment detection and gets designed once that exists.

## Acceptance tests

Built from the real channels. A stage merges only when its tests pass.

### Stage 1 — resolver, day-parts only

| Channel | When | Expected |
|---|---|---|
| Nick Picks | Mon 10:00am | 90s Nick 70% / 90s Nick IDs 30% (4 min cooldown) |
| Nick Picks | Mon, break after the last 90s Nick show | Nick at Nite |
| Nick Picks | Fri 6:00am | 2000s Nick ~80% / IDs ~20% (5 min) / music videos remainder (30 min) |
| Nick Picks | Fri, break after the last 2000s Nick show | Friday Nick at Nite |
| CCN | Mon 6:00am | Powerhouse 95% / CN Groovies 5% (3000s) |
| CCN | Tue 12:00am | Adult Swim [weekday] |
| CCN | Sat 7:00pm, January | CN City Night |
| CCN | Sat 8:00pm, July | CN City Night |
| CCN | Sun 12:00am | Toonami AcTN |
| CCN | Sat 12:00am | Powerhouse 95% / CN Groovies 5% — the weekday day-part still running from Friday |
| CCN | Sat 3:00am | Powerhouse only |
| Any channel without day-parts | Any time | Existing Flex tab, unchanged |

### Stage 2

| Channel | When | Expected |
|---|---|---|
| CCN | Wed, break between the 2:30 and 3:00 shows | Toonami — Powerhouse 30% / Toonami promos 70% |
| CCN | Thu, same break | Weekday day-part — Toonami doesn't air Thursday |
| CCN | Mon, break after the 4:30 show | Weekday day-part |
| CCN | Mon, 4:30 show overruns to 5:05, break after it | Weekday day-part |
| CCN | Sat 1:00am | Toonami (midnight run airing) |
| CCN | Sat 3:00pm | CN City Day 70% / Miguzi 30% |
| CCN | Fri, break between Toonami's last show and CCF's first | CCF |

### Stage 5

These are built as plan rows in `test/blocks-acceptance.js` (step 3), each on a
fixture of its own, so they hold whatever the real block times are; the times
named below are the spec's examples and not what the rows depend on. The three
rows about a stream running late, very late or tuning in need the cursor and
are tested with step 4's (built); "Next Time" in the Cartoon Theatre row needs
`keyedOn: 'later'` (step 8). Added at step 3: the Nick at Nite rows, in which a
WBRB and a BTTS marked `onlyIfNoMatch` play only when the Up Next step found
no bumper - with a Next Promos step ahead of it that finds nothing and an Up
Next that plays (both stay out), neither finding anything (both play), a promo
that plays and an Up Next that finds nothing (both still play), and an Up Next
that falls back to its generic list (both stay out) - and a Grim row where the
show after Grim is not Foster's.

- **Fri, Toonami → CCF:** Toonami sign-off → CCF Up Next → Flex → CCF intro → CCF host intro → CCF show intro → first show
- **Inside CCF, episodes of one show:** WBRB → Flex → BTTS
- **Sat, Miguzi → Cartoon Theatre:** Miguzi ending → CN City Miguzi outro → Flex → CN Cinema bumper → Cartoon Theatre intro → movie
- **Sat, Cartoon Theatre → Grim:** Next Time (if applicable) → Cartoon Theatre closing → CN City Grim bumper → Flex → Now/Then (Grim / Foster's) → Grim
- **Now/Then when Grim is followed by anything other than Foster's:** skipped
- **CCF's last show:** no WBRB; the boundary sequences fire instead

From channel 1's own lineup, with a between-shows sequence on the Adult Swim day-parts of one `show` step keyed on `next` from a list of NEXT clips, skip if none, on both sides:

- **ATHF → Space Ghost, Wed 1:56am (the Sep 30 airing):** 15s "SGC2C NEXT promo" → Flex → 10s "NEXT - SGC2C" → Space Ghost — the shape the hand-inserted items have today
- **Space Ghost → a show with no NEXT clip:** Flex only; both steps skipped
- **A stream 20s late into that break:** both NEXT clips play whole; the Flex is 20s shorter
- **A stream later than the whole break:** no Flex; both NEXT clips still play, from their start, then the show from its start
- **Tuning in 8s before the break ends:** the 10s "NEXT - SGC2C" plays, then the show; the 15s promo does not
- **Mon 2:50pm, weekday day-part → Toonami block:** Toonami `entering` fires with the day-part's `leaving`; a between-shows sequence on either context does not
- **Week of Oct 18, 2026:** 442 breaks resolve as 117 between episodes, 297 between shows, 28 boundaries (113 / 301 / 28 before the Oct 2 boundary edits); a channel with no sequences configured plays exactly what it plays today in all 442

Added at step 3b, each a plan row on a fixture of its own (the Nick channel's
patterns under "Worked examples from the Nick channel", the CN City lists, and
the two options):

- **Hey Dude → Clarissa:** Clarissa WBRB → Flex → Up Next (Clarissa)
- **Clarissa → Doug, entering Nicktoons:** Nicktoons Intro → Flex → Up Next (Doug) → Nick Bumper (Doug)
- **Hey Arnold → Are You Afraid of the Dark?:** Flex → the show's NEXT promo; **Hey Arnold → a show with no promo:** Flex only
- **Into Kenan & Kel:** Flex → Nick Bumper → Back to the Show
- **Entering Nick at Nite, Tue and Sun:** Flex → Up Next (The Cosby Show) (More) → Sign On; **Mon:** Sign On → Flex → Up Next (The Cosby Show) (More)
- **A step limited to Mondays, on a Tuesday:** found nothing, so the step marked `onlyIfNoMatch` on it plays; **on a Monday:** it plays and the marked step stays out
- **A 50% Up Next out with the same Up Next marked in, roll under 50:** Up Next → Flex; **roll over:** Flex → Up Next
- **CN City, a show with no Up Next:** Flex → a bumper for a different show from "CN City Bumpers [DAY]"; **when the show has its own bumper there:** that one, though another has been idle longer; **a show with an Up Next:** the Up Next; **the same clips in a list without the setting:** Flex only; **between two episodes of a show with no bumper:** two different bumpers, out then in

## Open questions

1. **Per-pair bumpers** (stage 5). Settled Oct 1, 2026, by measurement: channel 1 has 281 distinct adjacent show pairs in a week, 222 of them seen once, and 293 across the whole lineup, so the week is the schedule and hand-entered pair rules cannot scale. Pair bumpers live in an ordinary filler list and each clip carries the shows it names, proposed from its title and fixed once on a review screen that also learns aliases such as SGC2C. A pair step falls back to a clip naming only the next show, then to a general list. See Stage 5, "Which shows a clip names".
2. **Long breaks spanning several contexts.** Settled during stage 1, by measurement rather than by reading. `createLineup` is re-invoked **once per filler clip**, each time with a fresh wall-clock `t0` — a two hour break produced 48 calls and no cache hits, because `getCurrentLineupItem` returns null as soon as a clip is exhausted. Across all of them `programIndex` never moves, so the neighbour the rule reads is the same on the first call and the last. A long break therefore plays **one** mix throughout, even where it spans a boundary, which is what "the filler starts after the 2:30 show" requires. The clock only re-enters for a break with no program neighbour, and there it should: nothing anchors it, so an all-Flex channel does change mix partway through.
3. **Per-list cooldown persistence.** Fixed in stage 1. Per-list last-played now lives in the same store as per-clip times (`<data>/play-cache/<channel>/`), under a key that cannot collide with a program key, so it is loaded at boot like everything else there. No new DAO and no migration.

   Fixing it exposed a defect underneath. Which list a clip is credited to was assigned twice, and the second assignment overwrote the first, so a clip chosen by the longest-idle branch was credited to whichever list happened to win the weighted draw — measured at 9 percent of picks. That was invisible while list cooldowns were forgotten on restart. Persisting them would have made it permanent, so it was fixed in the same pass.
4. **One-off airings.** Deferred. Adding a single-date option to an airing is small and non-breaking later, and leaving it out keeps the stage 2 editor simpler. Revisit when a one-off marathon is actually wanted.

## Notes

- **The neighbour-context break rule is stage 1, not stage 2.** It was listed under stage 2 originally, but stage 1's own acceptance rows need it: *"break after the last 90s Nick show → Nick at Nite"* only resolves that way if the break takes its context from the show that follows it. A clock rule gives the outgoing mix there. `programIndex` has no other purpose than finding that neighbour, and stage 1 is the stage that asks for it. Stage 2 extends the same rule to block contexts.
- **For the mix alone, both branches of the break rule land on the incoming context**, so stage 1 only computes that side. The branches are still written as two in this spec because stage 5 picks a different transition sequence for a boundary than for a break inside one context.
- **Saturday 12am needs no configuration.** There is no Adult Swim start on Saturday, so the weekday day-part that began Friday 6am simply runs on — which is the wanted mix. This also confirms that inheriting the previous day-part across days is the right fallback. Saturday 3am needs one start, with a Powerhouse-only mix, running until CN City Day at 6am. If Saturday overnight should carry its own name in the guide and the Block Schedule Manager, add a 12am start with the same mix purely for the label.
- **Blocks never restrict manual scheduling.** They only decide which filler plays. Inserting items anywhere in the lineup, reordering it, and building an all-day marathon by hand all keep working exactly as they do now. An overlay can't take that away, because it never touches the lineup.
- Adult Swim starts Sunday at 10pm but Monday–Thursday nights at 12am. The continuous chain expresses that irregularity with no special case — Sunday's 10pm start simply runs until Monday's 6am start.
- Clip cooldowns are persisted per channel and clip, and shared across contexts. Only CN Groovies carries a cooldown, and it lives only in the weekday day-part, so this has no effect on the current channels.
- **The daylight-saving option has no visible effect on the current Saturday schedule.** Cartoon Theatre covers 7–8pm in both seasons, which is exactly the hour that shifts. It stays in stage 1 because it's small and becomes useful the moment the schedule changes.
