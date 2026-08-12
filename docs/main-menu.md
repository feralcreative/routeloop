# Main menu

The nav's shape and contents. Ziad's structure, with the four gaps resolved on 2026-08-09—those answers are marked **[decided]**. Anything here is his call; do not change it without asking.

## Shape

Four top-level groups on the left, the account menu pinned right. `Riders` is a plain link; everything else opens a panel.

At LG (≥992px) this renders as a bar. Below that, and on map pages at any width, the same markup is the drawer. Both are native `<details>`, so the menu works with JavaScript off.

## The tree

```text
Rides ▾
  Your rides          /dashboard
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

**[decided] No Home item.** The logo links to `/` and that is the convention. Dropped rather than duplicated.

**[decided] Settings is stubbed.** `/settings` gets a real page with nothing on it yet, so the link is not dead. What goes on it is open.

## Open

- **What Settings holds.** Two entries are now decided, both from the 2026-08-10 builder click-through and both tracked under roadmap item 16: **the stop-duration format** (hours to one decimal by default, switchable to hours+minutes or plain minutes), and **un-dismissing the exit confirmation**, if that confirmation survives the autosave work at all. Units (miles/km), default ride visibility and email preferences remain the obvious untaken candidates.
- **The avatar.** `users.avatar_url` exists and is populated from Google sign-in. Riders who used a magic link have none, so the account trigger needs a fallback—initials on a tinted disc is the cheapest, but it is not decided.
