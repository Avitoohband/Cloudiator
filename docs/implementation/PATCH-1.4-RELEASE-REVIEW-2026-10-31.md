# Patch 1.4 — Avi's production review

**Release candidate, not live. Production go is pending.** The full local gate passed 12/12 on `b7d3651`, exit 0;
see [the gate evidence](PATCH-1.4-GATE-2026-10-31.md). The following preparation changes documentation only.

## Patch-note draft

Kind: `patch-notes`. Action: none. This is the exact text prepared for posting, subject to Avi's approval.

**Title:** Patch 1.4: watch your expedition, gladiator cards and a clock

**Preview:** Watch your gladiator's trip live or replay it whole, open any gladiator's card, and pick a 12- or 24-hour clock.

**Body:**
- p: What changed:
- li: Watch your expedition: while your gladiator is away, a button on the camp shows where it is and opens the live view, marked LIVE with each fight on its timeline.
- li: Replay a whole trip in about a minute and a quarter: out through the camp gate, the fights at their real speed, home, and to bed when a Rest follows.
- li: Gladiator cards: click any name to see their look, class bonuses, attributes, stats, gear and Arena record.
- li: New arrivals: everyone in the camp sees a banner when a new gladiator arrives, and the Gladiators list shows newcomers first.
- li: My gladiator shows your class's bonuses and its suggested split of points. When you plan a build, Suggested spends the points left your class's way.
- li: A Rest says how much stamina it will give back.
- li: Clock: choose a 12-hour or 24-hour clock in the menu under your name.
- li: On a phone, tap your name to see your stamina, gold, renown and the time to the next slot.
- li: The Gladiators list shows how many players there are and where they are.
- li: On an expedition, gladiators now search slowly around each spot.
- li: Patch numbers: the menu under your name shows your patch, each patch note shows its number, and Patch history lists every patch. When a new patch is out, Reload brings it in.

Local validation: title 61 characters, preview 112, body 12 blocks/1,219 characters; `private.valid_message_body` returned true
on the verified local stack. The statement is UTF-8 without a BOM at `%TEMP%/cloudiator-post-1.4.sql`; it has not been executed.

## For Avi at the go

1. Phone patch-note number buttons are **24 px**, versus the project's usual 44 px target (approved mockup: 23 px).
2. The arrival banner and reload notice step aside/hide under the account menu and Messages.
3. The desktop account menu is **240 px** wide, versus the mockup's 268 px.
4. The welcome banner says **NEW ARRIVAL**.
5. Whole-trip replay length has no upper bound; fights remain at real speed (normal trips are about 75 seconds).
6. Chapter names can wrap on a phone.

The previously approved clickable references remain under `.superpowers/design/2026-10-29-patch-numbers/` and
`.superpowers/design/2026-10-29-profile-card/`; final 360 px screenshots are in the stream ledger's `final-shots/` folder.

## Patch-history row

Number: **1.4**. Title: **Watch your expedition, gladiator cards and a clock**. Planned date: **2026-10-31**; the server's
actual release timestamp is set when the approved row is recorded. These are [CHANGELOG.md](../CHANGELOG.md)'s 14 feature
lines word for word, unchanged from the gated source:

- New arrivals: everyone in the camp sees a banner when a gladiator arrives. Find takes you to the gate, and the Gladiators list shows newcomers first with a NEW tag.
- My gladiator shows your class's bonuses and its suggested split of points. When you plan a build, Suggested spends the points left your class's way.
- A Rest says how much stamina it will give back, in the Schedule and on My gladiator.
- Clock: choose a 12-hour or 24-hour clock in the menu under your name. Every time in the game follows it on this device.
- On a phone, tap your name to see your stamina, gold, renown and the time to the next slot.
- The Gladiators list shows how many players there are and where they are now.
- On an expedition, a gladiator searches slowly around each spot instead of squatting.
- The live view of an expedition shows LIVE with the minute and names each mark on its timeline: leaving camp, each fight and the way back. Watch from the start replays what you missed, never past now.
- Replay a whole trip in about a minute and a quarter: out through the camp's gate, the trail, the fights at their real speed, home through the gate, and to bed in camp when a Rest follows.
- A replay names and draws your gladiator from its first moment, not only from its first fight.
- While your gladiator is away, a button on the camp shows where it is and opens the live view. Once it is back, the same button offers the whole trip with your own result.
- Patch numbers: the menu under your name shows the patch you are playing, each patch note shows its number, and Patch history lists what every patch added.
- When a new patch is out, an open game says so, and Reload brings it in.
- Click a gladiator's name to open a bigger card: their look, class bonuses, attributes, stats, gear with level and rarity, Arena record and days in camp.

`node scripts/patch-statement.mjs 1.4` generated `%TEMP%/cloudiator-patch-1.4.sql` locally. Before execution it must be regenerated
with the newly posted note's id. The nine existing patch/parser/statement regression tests passed with the dated candidate.

## Production go scope

The go question names these four writes, in order:

1. Apply **M26 only**, `20261030055918_patch_1_4.sql`, using `--skip-vault` on the migration-only dry-run and push.
2. Fast-forward `release` to the reviewed candidate and let Cloudflare Pages publish it; run the **22 deployed probes**.
3. Post the exact patch note above after its client is live.
4. Record patch **1.4**, the title and feature lines above, linked to that note.

Preflight must still confirm the intended production ref, remote history ending at M25, a dry-run listing M26 only, matching
seed note titles, the permitted release window and no open boundary. M26 backfill/links, fingerprint and access read-backs
remain required. The migration has no down migration; a 1.3.1 client works on M26 for a client rollback. Follow Task 12 and
the M26 migration record. A go for M26 alone does not authorize the remaining three writes.

After a successful release, remind Avi about the combined **1.3.1 + 1.4 patch clip** and its feature posts, then continue
1.5 Arena replays, 1.5.1 NPC review/art approval and 1.6 economy in the assigned order.
