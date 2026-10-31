# design docs

these are the habit-system design documents that the product spec (`SPEC-habit-system.md`) was derived from. copied from rami's life-os workspace (`life-os/projects/better-habit-system/`) on 2026-09-08. that workspace stays the living home of the habit *system* (the rules rami runs his days by); this folder is the snapshot the *app* was specified against. when the two disagree, the spec wins for the app and the life-os files win for the system.

| file | what it is |
| --- | --- |
| `habit-os-context.md` | who the user is, the intellectual foundations (atomic habits, deep work, psycho-cybernetics), working principles, and the software angle. read first. |
| `habits-v2.md` | the six-habit night-to-morning chain with identity votes, implementation intentions, stacks, two-minute floors, the daily-note checkbox block, and the rules (never miss twice, weekly count, floors count). the app's `daily` boards, anchors, and stacks come from here. |
| `rewards-and-coins.md` | the coin ledger: what earns a coin, caps, the reward menu, redemption protocol, amendment rule. the app's `earnsCoins`, cap, and rewards come from here. |
| `coin-casino.md` | the physical variable-reward layer (jar + die). the roll is deliberately NOT in app v1; kept here for the later chance-mechanics spec. |
| `night-shutdown.md`, `morning-ignition.md` | the two v1 keystone habits in full. |
| `source-notes.md` | every voice-note transcription that fed the habit list and the reward system, with extracted signal and the open tensions the interview resolved. |

## links that do not resolve here

- `[[wiki-links]]` in these files point at rami's obsidian vault. the vault is not in this repository and its notes are personal. do not try to fetch them; the extracted signal is already in `source-notes.md`.
- the reward system's source video, "I built a habit system as addicting as a casino" (SpoonFedStudy, https://www.youtube.com/watch?v=Qji8_5XgMW4), is referenced but its transcript is third-party content and is not copied here.

## privacy

these historical documents describe one person's routines, prayer times, sleep, and reward preferences. they are retained from the already-public flint local history. rami authorized making flint public on 2026-10-30; the product spec remains the source of truth for application behavior.

## App specification correction (2026-09-08)

The source notes describe Rami's personal routine, including its progression from night to morning. The app's approved specification now restricts each stack completion to one logical date. Night and morning routines do not share a run across consecutive dates. Usual times are informational. The previous proposal to change wake's anchor to the previous night's bed is superseded; preserve the original alarm anchor. `SPEC-habit-system.md` governs the application.
