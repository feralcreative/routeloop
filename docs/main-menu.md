# Main menu

The nav's shape and contents. Ziad's structure, with the four gaps resolved on 2026-08-09—those answers are marked **[decided]**. Anything here is his call; do not change it without asking.

## Shape

Four top-level groups on the left, the account menu pinned right. `Riders` is a plain link; everything else opens a panel.

At LG (≥992px) this renders as a bar. Below that, and on map pages at any width, the same markup is the drawer. Both are native `<details>`, so the menu works with JavaScript off.

## The tree

```text
Rides ▾
  Home                /
  Your rides          /rides
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
  Settings            /settings
  Sign out            POST /logout
```

Signed out, the menu is `Find a ride`, `Riders`, `About ▾`, and `Join the beta`.

## Decisions

**[decided] Import / Export is one page.** `/import` grows an export half rather than a second page being created beside it—the URL already exists, the FAQ links to it, and import is the primary action. The label in the menu is "Import / Export".

**[decided] "About this app" stays in the menu.** It is the only trigger for the alpha modal. Privacy and Terms are deliberately *not* in the menu; the footer carries them on every chrome page, and the splash carries them signed out.

**[decided] `/admin` becomes an overview.** Today it *is* the approvals screen. Approvals moves to `/admin/approvals` and `/admin` becomes the landing page the group's first item points at. `/admin/survey` already existed and was missing from the first draft; it is listed now.

**[decided, then reversed 2026-08-15] A Home item, first in the Rides group.** The original decision was that the logo links to `/` and that is the convention, so a Home entry would be duplication. That reasoning held only while `/` was a landing page. It is not: `/` is the **dashboard**—hero miles, tiles, the storage meter, the twelve-month chart—and the only way to reach it was a logo nobody reads as "my stats". The tell was in the code: `NavKey` has carried `'home'` since the menu was built and `home.tsx` sets `navKey: 'home'`, but no item ever carried the key, so the `aria-current` state was wired and permanently unreachable.

**[decided 2026-08-15] "Your rides" moved from `/dashboard` to `/rides`.** The old URL described the page as a dashboard when the dashboard is `/`. See the header of `src/routes/rides.tsx`. `/dashboard` 301s to `/rides`.

**[decided] Settings is stubbed.** `/settings` gets a real page with nothing on it yet, so the link is not dead. What goes on it is open.

**[shipped 2026-08-15] Settings has its first real setting.** The stop-duration format—hours to one decimal by default, switchable to hours+minutes or plain minutes. It posts to `/settings/duration-format` and writes one column, `user_profiles.duration_format`, rather than going through the profile form's POST, which validates and rewrites the whole profile and would need every other field carried along. The page is no longer a stub, though it is still short.

## Open

- **What Settings holds.** Both entries from the 2026-08-10 builder click-through are now closed rather than open. **The stop-duration format shipped 2026-08-15** and is on the page. **Un-dismissing the exit confirmation is moot**: autosave removed the confirmation, so there is nothing to un-dismiss—nothing is unsaved by the time a rider leaves. Units (miles/km), default ride visibility and email preferences remain the obvious untaken candidates and are the whole of what is still open here.
- **The avatar.** `users.avatar_url` exists and is populated from Google sign-in. Riders who used a magic link have none, so the account trigger needs a fallback—initials on a tinted disc is the cheapest, but it is not decided.
