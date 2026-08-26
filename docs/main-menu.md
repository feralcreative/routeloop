# Main menu

The nav's shape and contents. Ziad's structure, with the four gaps resolved on 2026-08-09—those answers are marked **[decided]**. Anything here is his call; do not change it without asking.

## Shape

Four top-level groups on the left, the account menu pinned right. `Riders` is a plain link; everything else opens a panel.

At LG (≥992px) this renders as a bar. Below that, and on map pages at any width, the same markup is the drawer. Both are native `<details>`, so the menu works with JavaScript off.

## The tree

```text
Exit map              /                (map pages only)

Rides ▾
  Your rides          /
  Plan a ride         /builder
  Find a ride         /explore
  Import / Export     /import

Riders                /riders          (plain link, no panel)

About ▾
  FAQ                 /faq
  Rider survey        /survey          (only if surveyInvitedAt)
  About this app      —                (opens the alpha modal)

Admin ▾                                (only if canManageRiders)
  Admin               /admin           (overview)
  Approvals           /admin/approvals
  Invitations         /admin/invites
  Survey results      /admin/survey

                                       ← the account menu is pushed right from here

{displayName} {avatar} ▾
  Your profile        /profile
  Preferences         /prefs
  ───
  Tell us something   /feedback
  Idea board          /board
  ───
  Sign out            POST /logout
```

Plus one thing that is not in the tree: a floating dock holding a **bug** mark and a **what's new** mark, on every page a signed-in rider can reach. See the decision below.

Signed out, the menu is `Find a ride`, `Riders`, `About ▾`, and `Join the beta`—plus `Exit map` ahead of them on a map page, pointing at `/`.

`Exit map` is the only item that is not on every page. It renders when, and only when, the page is a map page, which is the same `isMap` the header already uses to decide whether to draw the logo.

## Decisions

**[decided 2026-08-19] The way off a map page is a menu item, and the panel's X is gone.**

The drawer header carried an X beside the collapse button, and Ziad's call is that it serves no purpose there: the two controls sit a millimeter apart and read as a pair, but they are not a pair—one keeps you on the map and the other leaves it entirely. Putting the more consequential of the two under a fingertip beside the lesser one is how a rider taps *leave* meaning *tidy away*.

- **The X is removed from both panels**, not just the builder. The reasoning does not change between the two, and leaving one behind would mean two ways out that disagree about where they live.
- **`Exit map` is the first item in the menu**, above the `Rides` group, so it is the first thing under the thumb when the drawer opens.
- **It replaces `exitHref` / `exitLabel` entirely.** Those were per-page options passed into `panelShell`; the destination is a function of nothing but whether a rider is signed in, so the header works it out and the two call sites stop passing anything.
- **It is a red button, not a text link**, added 2026-08-19. It is the only item in this menu that leaves the page rather than moving around inside it, and a column of identical text links gave it no way to say so. **Outlined at rest and filled on hover**: red text on a red keyline over the menu's white, inverting to the white legend on a solid `$stop` field when a pointer is on it. One red is involved either way—`$stop` is the road-sign palette's only one, and `$kml` is an alias for the same value. Note this reverses the reasoning on the control it replaced, which deliberately avoided red on the grounds that leaving is not destructive now that the builder autosaves—Ziad's call; the button is red because it is the one door out, not because it is dangerous.
- What this gives up, stated plainly: the exit is now two taps rather than one. That is the point—leaving is not a thing to do by accident, and the collapse button, which is the one riders actually reach for, keeps its corner to itself.

**[shipped] Import / Export is one page.** `/import` grew an export half rather than a second page being created beside it—the URL already exists, the FAQ links to it, and import is the primary action. The label in the menu is "Import / Export". **This is built**, not pending: `src/routes/import.tsx` renders `<h1>Import / Export</h1>` over two `.transfer-head` sections, and the export half lists the rider's own rides with a per-format download row. It read as an open decision here until 2026-08-16 and misled a planning pass; the URL keeps the singular name it shipped under.

**[decided 2026-08-16] Settings is renamed Preferences, and the canonical URL is `/prefs`.**

The label everywhere a rider reads it is **Preferences**. The URL is the short form on purpose—it is typed and shared more than it is read, and `/preferences` earns nothing for its extra six characters.

- `/prefs` is canonical and the only URL the app links to or renders.
- `/settings` and `/preferences` both **301** to it, matching the `/dashboard` precedent in `src/index.tsx`, which now points at `/` since `/rides` folded into it on 2026-08-24.
- **The POST endpoint is the trap.** `/settings/duration-format` is a form action, and a 301 does not preserve the method—a browser turns the redirected POST into a GET and the save silently does nothing. The form action moves to `/prefs/duration-format`, and the old path either stays mounted as a real alias or redirects **308**, never 301. A rider sitting on a page rendered before the deploy is the case this protects.
- `settings.tsx` and `settingsRoutes` rename with it, and `NavKey`'s `'settings'` becomes `'prefs'`. `account.tsx` sets that key on three pages and links "Back to settings" twice—that copy becomes "Back to preferences".
- **Reserve the new names as usernames.** `RESERVED_USERNAMES` in `src/auth/username.ts` holds `dashboard`, `profile`, `builder` and the rest, but **not `settings`**—a live route that was simply missed. Add `prefs`, `preferences` and `settings` while the list is open. Nothing is broken today because no root-level `/:username` route exists yet, which is exactly the window that list says it exists to protect.
- Also update: `docs/api.md`'s route table, `src/db/schema.ts`'s comment on `duration_format`, `public/js/builder.js:77`'s comment, and `test/duration.test.ts`, whose case name says "the settings page".

**[decided 2026-08-16, shipped] Feedback gets two entry points, and the floating one pre-fills `?area=`.**

Three candidates were put up: a persistent item in the account menu, a floating button on the builder and viewer only, or both. **Both** was chosen.

- **The account menu** carries `Tell us something` → `/feedback` and `Idea board` → `/board`, above the sign-out rule. It is what a rider on any other screen has, and what someone looking to re-read their own reports goes to.
- **The floating button** rendered only on the builder and the viewer, and it existed for one reason: it carries `?area=`, which is what lets the intake offer a one-tap confirm instead of an eight-chip group. That is a real accuracy win on the one field riders are worst at answering. **Superseded 2026-08-23—see below.**
- It is a plain `<a>`, not a scripted overlay, because it has to work when the page around it is the thing that is broken.

**Its position is measured, not chosen.** Google stacks fullscreen and zoom in a 40px column down the right edge of the map, running from roughly y=823 to the attribution strip—so the bottom-right corner is unusable, and lifting the button vertically only moves it onto the fullscreen control. It is inset from the right edge instead. Re-measure `.gmnoprint` and `.gm-control-active` if the map's control layout changes.

**[decided 2026-08-23, shipped] The floating button becomes a dock, on every page.**

It was on the builder and the viewer only, on the reasoning that those are where things break. Half right, and it cost the other half: a rider who hits something wrong on `/rides`, `/import` or their profile is exactly as stuck, and their only way in was an account-menu item they had to already know about. It now renders wherever a signed-in rider is, and carries a second mark for the release notes.

- **`feedbackArea` on `PageOpts` no longer decides whether it appears**—only whether the report arrives with `?area=` pre-filled. It stays opt-in rather than inferred because `areaFromPath()` in `src/feedback/policy.ts` is the one inference mechanism and it is reached from the request; `page()` never sees a path, so anything worked out there would be a second mechanism free to disagree with the first. No area simply means no pre-fill, which the intake is built for.
- **Signed out gets nothing**, on the splash or anywhere else. The intake requires an account.
- **The feedback flow itself is the one exception**, in CSS rather than in a prop: the bug mark would open the page it is sitting on, and that flow is built around a sticky full-width control at the bottom edge, which is the only thing in the app the dock has to argue with.
- **It is a dock, not two loose marks**—one translucent capsule holding both, on `$z-fab` above the nav. Two unattached discs in a corner read as something the page put there; one surface reads as chrome, which is what it now is. Over a map the capsule is the same `$panel-bg` as Google's own controls, so it joins that family instead of competing with it.

**[decided] "About this app" stays in the menu.** It is the only trigger for the alpha modal. Privacy and Terms are deliberately *not* in the menu; the footer carries them on every chrome page, and the splash carries them signed out.

**[decided] `/admin` becomes an overview.** Today it *is* the approvals screen. Approvals moves to `/admin/approvals` and `/admin` becomes the landing page the group's first item points at. `/admin/survey` already existed and was missing from the first draft; it is listed now.

**[decided, then reversed 2026-08-15] A Home item, first in the Rides group.** The original decision was that the logo links to `/` and that is the convention, so a Home entry would be duplication. That reasoning held only while `/` was a landing page. It is not: `/` is the **dashboard**—hero miles, tiles, the storage meter, the twelve-month chart—and the only way to reach it was a logo nobody reads as "my stats". The tell was in the code: `NavKey` has carried `'home'` since the menu was built and `home.tsx` sets `navKey: 'home'`, but no item ever carried the key, so the `aria-current` state was wired and permanently unreachable.

**[decided 2026-08-15] "Your rides" moved from `/dashboard` to `/rides`.** The old URL described the page as a dashboard when the dashboard is `/`. See the header of `src/routes/rides.tsx`. `/dashboard` 301s to `/rides`.

**[superseded 2026-08-24] `/rides` is folded into `/`, and the two entries above collapse into one.** Ziad's call, answering the third of [#103](https://github.com/feralcreative/routeloop/issues/103)'s four open questions. `/` was the numbers page carrying a six-ride "Picking up where you left off" strip while `/rides` held the full list—two doors onto the same room, which is exactly the thing the 2026-08-15 split was meant to end and only moved. One page now: the stats, then every ride you own. `/rides` 302s to `/`, and `/dashboard` points straight at `/` rather than chaining through it.

**The menu item is labeled "Your rides" and points at `/`.** It keeps the key `home`, because `home.tsx` is still the file and `/` is still the route—only the label changed. "Home" was the wrong word for it once the page absorbed the list: the group is already called Rides, and a menu names destinations by what you want from them rather than by where they sit. The stats are the page's furniture; the rides are the reason to go. **`NavKey` loses `'rides'` entirely** rather than keeping a member no item carries—that is the precise shape of the dead `aria-current` state recorded in the entry above, and leaving it would rebuild the trap the same week it was documented.

**[superseded] Settings is stubbed.** `/settings` gets a real page with nothing on it yet, so the link is not dead. What goes on it is open. **No longer true**—see the two entries below: the page gained its first real setting on 2026-08-15 and is being renamed on 2026-08-16. Kept because it records why the link existed before the page did.

**[shipped 2026-08-15] Settings has its first real setting.** The stop-duration format—hours to one decimal by default, switchable to hours+minutes or plain minutes. It posts to `/settings/duration-format` and writes one column, `user_profiles.duration_format`, rather than going through the profile form's POST, which validates and rewrites the whole profile and would need every other field carried along. The page is no longer a stub, though it is still short.

## Open

- **What Settings holds.** Both entries from the 2026-08-10 builder click-through are now closed rather than open. **The stop-duration format shipped 2026-08-15** and is on the page. **Un-dismissing the exit confirmation is moot**: autosave removed the confirmation, so there is nothing to un-dismiss—nothing is unsaved by the time a rider leaves. Units (miles/km), default ride visibility and email preferences remain the obvious untaken candidates and are the whole of what is still open here.
- **The avatar.** `users.avatar_url` exists and is populated from Google sign-in. Riders who used a magic link have none, so the account trigger needs a fallback—initials on a tinted disc is the cheapest, but it is not decided.
