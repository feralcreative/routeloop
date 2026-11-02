---
kind: app
checked: 2026-10-31
---

# Groups and riders

The people on a ride: groups, meeting points, splits, who rides which route, the roster, permissions, votes, suggestions, comments, visibility, and the Paddock.

## What you can and cannot do here

You can read, per route, which group rides it ("ridden by <group>"), whether it is an alternate and which alternate is active, and each point's categories (including Home, Gas, and Charge). Nothing else in this area is visible to you: not the roster, RSVPs, who rides each route, bikes or ranges, votes, suggestions, comments, or visibility. Never state how many riders are coming, who is on a route, or a bike's range; ask the rider.

You cannot change groups, meeting points, splits, the roster, permissions, votes, comments, visibility, or bikes. Routes you add are ridden by everyone. Explain the rule and name the exact screen.

Your edits have side effects: removing a stop moves comments pinned to it onto the ride; changing a route's points makes pending suggestions on it stale; moving points after a meeting point was accepted does not re-sync the groups' departures.

## Who can do what

The ladder: View only < Can comment < Can suggest < Can edit, with owners above all four.

- View only: see the ride, roadbook, and On the road page.
- Can comment: also comment on the ride and on stops.
- Can suggest: also propose a replacement route. The default for anyone invited.
- Can edit: change routes, points, legs, groups, and alternates in the builder. Nothing else.
- Owner: also visibility, the roster, rungs, accepting suggestions, vote deadlines, and deleting.

A ride can have co-owners. The creator (who made the ride) pays the storage, including for editors' saves. These are creator-only in practice, although co-owners see the buttons and get "not found":

- Find meeting points.
- The builder's Riders tab: listing, adding, Send, removing, and assigning groups.
- Choosing who rides each route, including saving riders after a split.
- Deleting the ride and restoring it from the bin.
- Private stop details (confirmation numbers, gate codes, private notes). Nobody else sees them; other people's saves leave them alone.

Co-owners can change visibility and, on the Roster page (`/m/<slug>/riders`), set rungs, remove non-owners, assign groups, set a vote deadline, and press Resolve now. An owner cannot remove another owner, and the last owner cannot leave.

## Groups

A group is riders who set off from the same place. Every ride has at least one. Where: builder, Groups tab (tabs are Routes, Groups, Riders).

- The first group is the main group, labeled Main. It cannot be deleted, and its departure is the clock everyone else is solved from. To change it, drag another group above it by its grip (arrow keys work too).
- Adding a group asks for a name, then a starting place from search, and creates that group's first route there. An empty name takes the place's name. New groups go to the end. Up to 31 groups, names up to 80 characters.
- Each row shows where the group sets off: the first point of its own first route, blank while that route is empty.
- A route tagged with a group is that group's; an untagged route is shared by everyone. Group routes then a shared route is a meet; shared then group routes is a split. The Meet and Split categories are labels only.
- Deleting a group makes its routes shared and its riders ungrouped.
- With two or more groups, the panel names the group with the farthest to ride and warns that a closer main group makes far riders leave early. A planner making their own nearby group Main is the usual mistake.
- Groups that never reach a shared route show "never converges"; the ride still saves.
- A new group cannot get riders until the ride saves; the Riders tab offers a save button.

## Meeting points

Builder, Groups tab, Find meeting points (shown with two or more groups). Anyone who can edit the ride may use it. It reads the saved ride, so wait for Saved first.

You can see the same answer with propose_meeting_points: up to three candidates per joining group on the main group's road, preferring a gas station or charger within one tank, ranked by each group's extra detour beyond its shortest way to join. It needs two or more groups and a drawn road for the main group; pass max_detour_mi only if the rider asks for more or less detour than their setting. It only proposes. To use one, the rider presses Find meeting points in the Groups panel and picks it, which adds it to the main group's route and that one group's, sets that group's departure, and cuts the shared stretch; each joining group is decided on its own. If it says the budget ran out, nothing is known about that stretch: never tell the rider there is nowhere to meet or no station.

- The destination is where the main group's route ends. Each joining group contributes only its starting point; one with no route gets its direct road to the destination routed for it. The main group never diverts, and no candidate is offered in the last fifth of its road.
- Each joining group gets up to three candidates with the extra miles each costs them and a numbered map dot.
- Gas stations are preferred; EV chargers on an electric ride (the ride's power setting, then the shortest-range bike's fuel, then the rider's default). With no station on the stretch it offers plain road points and says so.
- Tank reach: a candidate must be within a tank of each group's last fill, using the shortest Range among riders planned for. No Range on file means no check. If every station is out of reach it offers them anyway and says so.
- Extra detour cap: how much farther than its cheapest way in a group may be sent. Default 10 miles, allowed 1 to 200, applied to the worst single group. The box beside the button is per press; the rider's default is Preferences, Meeting points. Empty means the default.
- A mile out of a group's way must buy a mile and a half of riding together. A group whose route already passes a candidate pays nothing.
- The rider's favor and avoid brand lists nudge stations by about 8 miles of score; they never remove one.

When it cannot help: one group; "Plan <group>'s route to the destination first" (main road not drawn); "No meeting point works without sending somebody a long way round. Check that every group's route ends at the same place." A group with no starting point is silently left out.

## Accepting a meeting point

Choosing a candidate (its row or its dot), each part its own undo step:

1. Adds the meeting point to every group's road.
2. Sets each joining group's departure so all arrive together (rounded down to the minute) and moves that group's earlier routes by the same amount. The main group's departure never moves. If the main route has no departure time, nothing changes and the rider is told.
3. Cuts the main route at the meet; the rest becomes a shared route starting at the arrival. Nothing to cut if the main route ends there.

Distances are estimates until accepted. Later edits do not re-sync departures.

## Splitting a group off

Some riders leave at a stop for their own destination. Where: a stop's row menu, Split a group off here. Pick who leaves (an existing group or a new name), tick the leaving riders, and pick a destination from search results; Split stays disabled until all three are set.

- Someone must leave and someone must carry on. Allowed at a middle stop or a route's first point, never its last.
- The continuation is tagged with whoever carries on (Main when it was shared). The leavers' route goes to the end of the list and starts at the arrival, not the next morning.
- The route they left then shows a line naming the group and destination that jumps to their route. Choosing a group that split before pre-ticks who last rode as it.
- Uses up to two routes of the 31. Saving riders on the new routes is creator-only; anyone else sees "The split is drawn, but who rides it could not be saved."

## Who rides each route

Group says where riders set off; the rider pill on each route row says who rides it (creator only).

- A route with no answer inherits the route before it; the first route is the whole roster. Empty means inherit.
- Each rider also rides as a group on each route; none means with the main group.
- Per-rider pages, roadbooks, files, and Maps legs follow this. A route added at the end inherits the last route's riders.

## The roster

Builder, Riders tab (creator), and the Roster page.

- Add any active rider by handle (blocks refuse silently) or a name with optional email for someone not on Routeloop. Up to 100, drafts included.
- States: Draft, Waiting (friend request pending), Invited (personal link emailed), member, declined.
- Drafts see and hear nothing, cannot vote or RSVP, but count for planning, including fuel range.
- Send invitations: a friend joins at once; a non-friend gets a friend request and joins on accepting; someone with an email gets a personal link; someone without stays a draft, named in "<names> need an email address first."
- A personal link shows the ride and its GPX with no account; no roster, comments, or private details. It can be revoked, and joining through it skips the beta waitlist.
- RSVP: Not answered, Going, Maybe, Can't make it, each rider for themselves. Maybe counts as coming; Can't make it drops them from the fuel range. Owners are notified.

## Votes on alternates

Alternates are routes grouped as candidates for one stretch, one active (unrelated to groups of riders). Vote on the Roster page.

- Any member votes once per alternate group; voting again withdraws, voting for another moves it.
- A winner needs a single leader with at least one vote. A tie or no votes changes nothing. No quorum, no tie-break.
- Without a deadline nothing resolves on its own. An owner sets one (checked every 10 minutes; the roster is notified of a winner) or presses Resolve now.
- Totals, the roadbook, the On the road page, and downloads use only the active alternate. You see which is active, never the votes; never say one "won."

## Suggestions

A Can suggest rider proposes a whole replacement for one route; an owner accepts or discards; the author or an owner can withdraw. It goes stale when the route's points change (which, order, kind, or position beyond about a meter); renames, colors, and times do not. Stale ones can only be discarded. Up to 20 open per rider per ride.

## Comments

Ride-level or pinned to a point, up to 4,000 characters, by members at Can comment or above; a share link never allows it. The author or an owner deletes or closes. A deleted point's comments move to the ride.

## Visibility and the home-address offer

Owners set it in the builder above the tabs.

- Public: anyone with the link; listed on Explore and the owner's profile; cloneable.
- Unlisted: anyone with the link; never listed; not cloneable. Not private.
- Friends: the owner's signed-in friends plus members; cloneable.
- Private: owner, members, and personal-link holders. New, imported, and cloned rides start private.

Members and link holders see the ride at every level. Following opens nothing.

Changing from Private to any other level, if the first route's first point has the Home category, the builder offers once per session to swap in the rider's public starting point. No offer if the rider has none (Profile, Public starting point). Other routes are not checked. If any shared route starts at a Home point, warn the rider.

## The Paddock and fuel checks

Account, Paddock tab (`/paddock`). Up to 50 bikes, every field optional: nickname, make, model, year, fuel (Gas or Electric), Range in miles (1 to 1,242), Comfortable range, tank size (up to 100 liters or 26.4 gallons), and a JPEG or PNG photo up to 1 MB. Make default picks the default.

The fuel ring, red E markers where a tank runs dry, the red dashed stretch, and the meeting-point tank check all use the shortest Range among riders on the ride. Comfortable and tank size are not used.

- Each rider picks their bike on the Roster page, else their default counts; before there are riders, the creator's default.
- Riders without Range are skipped, so the answer can be optimistic. With none anywhere there is no fuel overlay. The Riders tab says "Plan fuel around N miles—<rider>'s <bike>" or "No ranges on file."
- If the shortest-range bike is electric, the plan uses chargers.
- Only the right category refills: Gas for gas, Charge for electric.
- The tank carries from route to route in each group's sequence, and a shared route starts as low as the lowest tank any group arrives with, so tag a Gas stop where riders actually fill up.

Ask the rider for the group's shortest range before judging fuel spacing.

## Not ready: people and groups

1. No Range on file. Shows "No ranges on file" and no fuel ring. Ask. Fix: each rider adds Range in Paddock.
2. Some riders lack Range. Shows "K people have no range on file." Treat fuel as optimistic until fixed.
3. Wrong bike counted. Fix: Roster page bike picker.
4. A joining group with no start. Blank start line; left out of meeting points. Detect: a group with no route "ridden by" it, or an empty one. Fix: Groups tab.
5. Never converges. Detect: every route carries a group tag. Fix: Find meeting points or add a shared route.
6. Main road not drawn. Fix: draw it, wait for Saved, press again.
7. Groups end in different places. Detect: compare last points with the main group's. Fix: one destination.
8. Wrong main group. The fairness note names a far group. Fix: drag it to the top.
9. Departures no longer meet. A joining group's ETA at the Meet point differs from the main group's. Fix: set_departure, or re-accept.
10. Main route undated, so nothing synced. Fix: set its departure, re-accept.
11. Meeting point out of range. Shows out-of-range candidates or an E before the meet. Fix: a Gas stop before it.
12. Drafts never sent. Shows "N drafts, not invited yet." Fix: Send invitations (creator).
13. Placeholders without email. Fix: add email, Send.
14. Riders Waiting or Invited. Fix: ask them to accept.
15. RSVPs unanswered. Fix: riders answer on the Roster page.
16. Riders on the wrong routes, often after a split. Fix: route rider pills (creator).
17. Split riders not saved. Fix: the creator sets riders on both routes.
18. Riders without a group. Fix: Roster page group picker.
19. Undecided vote. Detect: an alternate group in get_ride. Fix: deadline, Resolve now, or pick the active route.
20. Pending or stale suggestions. Fix: accept or discard.
21. Open comments. Fix: read and close.
22. Home address exposed. Detect: a route starts at a Home point; ask about visibility. Fix: public starting point, or keep it Private or Friends.
23. Private ride meant for a group. Fix: Send invitations or choose Unlisted.
24. Roster full at 100. Fix: remove unneeded drafts.
