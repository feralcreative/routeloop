# Verifying the save-error dialog

Manual test recipes for the error notification added in [#233](https://github.com/feralcreative/routeloop/issues/233). Nothing automated covers this—it is a dialog in the builder, so it has to be looked at.

Written 2026-09-03, against branch `fix/save-errors-and-day-seed`.

## Before you start

On a machine that has not seen this branch:

```bash
git fetch && git switch fix/save-errors-and-day-seed
npm install
docker compose up -d --wait db
npm start
```

`npm start` runs the migrations first, opens `http://localhost:6686/` once the server answers, and watches for changes. If port 6686 is already bound, kill what holds it rather than starting on another port.

Then open any ride in the builder—`/builder/<id>`—and keep the panel visible. The save readout is the small line at the bottom left of it.

## What you are checking

There are three variants of the dialog and they deliberately say different things, so all three are worth seeing. Each one has a different heading, a different explanation of what is at risk, and only one of them offers to reload.

### 1. "This ride cannot be saved yet"

The easiest, and it needs no developer tools.

1. Open a ride with only one day, or delete days until one is left.
2. Delete that day's only point from the row menu.
3. Press **Cmd+S**, or wait three seconds for the autosave.

Every day now has no points at all, so the save is refused in the browser before anything reaches the server. The dialog should name the reason rather than showing a bare failure.

Press **Cmd+Z** afterwards and the point comes back.

### 2. "This ride did not save"

The real failure path, where the request goes out and does not come back.

1. Open DevTools, go to the Network tab, and set the throttling dropdown to **Offline**. Stopping the dev server does the same thing.
2. Type something into a stop name so the ride goes dirty.
3. Press **Cmd+S**.

You should get the message the request failed with, plus a line saying your work is still in the panel and a recovery copy is in the browser. Both are true, and that is the question a rider actually has when a save fails.

Now set the dropdown back to **Online** and wait about fifteen seconds for the retry. The ride saves, the dialog closes itself, and the Details button disappears. That last part is what proves the once-per-message memory resets—so a genuinely new failure will still be shown rather than swallowed.

### 3. "Someone else edited this ride"

1. Open the same ride in two browser windows, side by side.
2. Edit **the same day** in both. The merge is per day, so editing different days will deliberately not collide.
3. Save one, then save the other.

This is the only variant that offers a **Reload the page** button, because reloading is the actual remedy here. The other two do not offer it on purpose: the work is still in the panel and in the recovery draft, and reloading is the one thing that would lose it.

## The Details button

Dismiss any of the three and look at the save readout again. There is a **Details** button beside it that reopens the dialog.

It exists because the readout is a fixed-width box that ellipsizes, which is the whole defect #233 was filed about—so without a way back in, a dismissed error would be unrecoverable. It is a real button rather than a click handler on the readout itself, because that readout is `aria-hidden` and a keyboard could never reach it. Worth tabbing to it to confirm that works.

## What you cannot reproduce any more

The original #233 trigger is gone by design. `ensureDayHasStop()` means the builder can no longer create a day with points but no stop, and demoting or untagging a day's last stop was already refused before this sprint. `saveBlockReason()` still checks for the shape, but only a ride stored broken by an older client—or an old recovery draft—can now produce it.

## Also worth a look while you are here

The same branch changed the wording of every validation failure. A message that used to read `days.1: a day needs at least one stop` now reads `day 2: a day needs at least one stop`. Any error you trigger in the builder should name days and points from one, the way the screen labels them, rather than as array indices.

For failure modes by symptom rather than by recipe, see [debugging.md](debugging.md).
