---
kind: app
checked: 2026-10-31
---

# Account and app

## What you can and cannot do here

You cannot change settings, notifications, keys, connected apps, bikes, places, storage, the bin, or feedback, and you cannot see any of them. Explain and name the screen. Account settings are one page with five tabs: Preferences (`/account`), Profile (`/profile`), Paddock (`/paddock`), Places (`/places`), and Robots (`/robots`); reach it from the account menu. Most options save themselves the moment they change; a group's border turns amber while saving and green when saved, and a Save button appears only if saving failed.

## Notifications

Fourteen kinds in four boxes on Preferences, Notifications. Each row has Email, Browser, and Mute checkboxes and a `?` explaining what triggers it; each column header has a tick-all box. Defaults: Email on and Browser off for every kind, except Release notes, which is off for both.

| Kind | Box | Sent when, to whom |
| --- | --- | --- |
| Comments | Rides you are on | Someone comments on a ride; to its owners, not the commenter or the rest of the roster |
| Suggestions | Rides you are on | Someone proposes a route; to the owners |
| Suggestion decisions | Rides you are on | An owner accepted or discarded your suggestion; to you |
| Votes | Rides you are on | A vote on alternates closed with a winner; to the whole roster. A tie sends nothing |
| Added to a ride | Who is coming | Someone put you on a ride |
| RSVPs | Who is coming | A rider answers or changes whether they are coming, or declines the invitation; to the owners |
| Friend requests | People | Someone asks to be your friend |
| Friend request accepted | People | Someone accepted. A decline sends nothing |
| New followers | People | Someone follows you. Unfollowing sends nothing |
| Report updates | Your account | A feedback report you filed changed status |
| Recycle bin | Your account | Something in your bin is deleted for good within 7 days |
| Storage | Your account | Your imported files reached 90% of your storage |
| Account deletion | Your account | Your requested account deletion is 7 days away |
| Release notes | Your account | A new release note was published |

Sign-in links, waitlist and approval mail, and personal ride invitations always send and have no switch.

- Mute: a muted kind still appears in the center, labeled Muted, but never counts in the badge, pops up, or emails. Email and Browser keep their settings underneath, so unmuting restores them. Muting also marks that kind's unread rows read. Mute from Preferences or with the mute button on a row in the center.
- The bin warning is one message for the whole bin, soonest first, naming the rides and their dates. A later warning updates that same message, moves it to the top, and makes it unread again.
- Notification center: `/notifications`, from the account menu. Newest first, up to 50. Opening it marks everything read; there is no dismiss or mark unread. A row that links somewhere shows "Read more." Rows are kept about two weeks.
- Badge: the unread count on the account chip; where the chip is inside the menu (map pages, narrow screens), a dot on the menu button.
- Browser notifications are raised by an open Routeloop tab; this is not push. Nothing arrives while no Routeloop tab is open; stored ones show when one opens. A visible tab checks once a minute, up to 10 at a time. Turn it on with "Allow browser notifications" on Preferences; the site never asks on its own. A refused browser permission must be undone in the browser's site settings.

## Preferences tab

- Appearance: palette (Default, High contrast, Colorblind), light or dark, motion, and map theme. A map theme change applies the next time a map page loads.
- Units: distance in miles or kilometers (twistiness follows); date order (month first, day first, or year first, written with dashes); 12-hour or 24-hour clock; how stop durations are typed and shown (decimal hours, hours and minutes, or minutes); fuel volume (follow my distances, gallons, or liters). These change display only. Until a rider picks a date order, it follows the browser's language.
- Vocabulary: vehicle (Motorcycle, Car, Bicycle) and power (Gasoline, Electricity, Feets). Pedal power is only for bicycles and a bicycle cannot be gas; impossible pairs are grayed. The words change across the app (gas station or charger, tank or battery), and riders can set their own word for 14 terms. A ride can carry its own vehicle and power, which wins over the rider's.
- Places and brands: two boxes, avoid and favor, one term per line or comma-separated, up to 1,000 characters each and 40 terms. Terms under 3 characters are ignored. Matched against the place name, never the address. It reorders search results and never hides or adds anything; favor wins when a term is in both. In meeting points it is a nudge of about 8 miles. You can tell the rider their search results already reflect these lists.
- Meeting points: the extra detour a joining group will accept, 1 to 200 miles, empty for the default 10. It seeds the dial beside Find meeting points.
- Notifications: above.
- GTFO: Download Me, Delete Me, and Save Me (below).

## Profile tab

Saves when idle; a username change and an address are committed only by the Save profile button.

- Who you are: display name (required), username (3 to 30 letters, numbers, or underscores; a released name stays reserved 30 days), and names.
- Picture: a JPEG or PNG up to 1 MB, cropped to a square.
- Home base: an address, a name (default "Home"), and "Start new private/friends-only rides at my home address." Used only on Private or Friends rides.
- Public starting point: somewhere like a gas station or trailhead. Without one, the builder cannot offer to replace a home start when a ride is shared.
- Splitting costs (Cash App, Venmo, PayPal, Zelle), Phone, and Elsewhere (social links). The payment and phone sharing boxes are stored but nothing shows these to other riders yet; do not promise riders will see them.
- Your public page (`/@handle`): who sees it, Anyone, Riders (the default; signed-in members), or Nobody (name, handle, and friend and follow buttons only). Bio up to 280 characters. Show my Paddock (off by default). List me on the Most Active board (off by default).

## Paddock tab

The rider's bikes. Range is what powers every fuel check; see the groups-and-riders guide for the rules. No bike with a Range means no fuel ring, no E markers, and no tank check on meeting points.

## Places tab

Saved places: up to 500 places in up to 50 groups, each with a name, location, up to four categories, phone, address, and up to five links. Saved from the builder. Using one copies it into a ride; editing or deleting the place later never changes existing rides. Deleted places and groups go to a Recycle bin fold under the list for 30 days. Deleting a group is meant to leave its places ungrouped; if a rider's places seem to have vanished after deleting a group, restoring the group from the fold brings them back.

## Robots tab and the AI features

Two ways to plan with AI, and the rider pays the model company directly for both; Routeloop charges nothing and pays for no model tokens:

1. The builder's assistant, on the rider's own Anthropic or OpenAI key, with no Routeloop spending cap.
2. Claude or ChatGPT connected over MCP at `<site>/mcp`.

There is no free allowance. A rider with no key of their own who opens the assistant is told to add one under Robots or connect Claude or ChatGPT.

The builder assistant is a floating window over the map that minimizes to a button. It proposes changes as one step the rider applies or discards (Undo works after applying); it refuses to apply if the ride changed meanwhile. It only appears for riders who can edit. Each message is up to 4,000 characters; the recent conversation is resent each turn and clears on reload. MCP changes save immediately and appear in an open builder.

Limits:

- In the builder's assistant, every turn: up to 12 model steps, 6 place searches, and 30 routed legs. A turn that hits a limit stops and says to ask it to carry on. Over MCP there is no per-turn limit, because each tool call is its own request; only the daily ceiling applies.
- Map calls: 300 a day per rider, from any source, own key included, resetting at midnight UTC.
- Builder: 20 messages a minute, one turn at a time. MCP: 120 calls a minute.

Own keys (Robots, Planning assistant): one Anthropic key and one OpenAI key. A key is checked with the provider when saved, stored encrypted, and only its last four characters are shown again; charges go to the rider's provider account. Models: Claude Opus 5.5, Sonnet 5.5 (default), Haiku 5.5; GPT-6 Astra, GPT-6.1 Sol (default), GPT-6.1 Terra, GPT-6 Luna. With both keys, "Which key answers" sets the default and the Claude | GPT switch in the window picks per message. Remove my key deletes it.

Connecting Claude or ChatGPT (Robots, Plan from Claude or ChatGPT): add `<site>/mcp` as a connector; the app sends the rider to sign in and approve. A signed-out rider signs in in another tab, then presses Continue. The consent page says the app can read rides, search places, and add, move, and remove stops on rides they can edit, but cannot delete a ride, change who can see one, or read private stop details on another rider's ride. Connected apps are listed with Disconnect.

No AI path can delete a ride, change visibility, edit the roster, or touch the bin.

## Dashboard

`/` on a computer, `/dash` on any device; phones go to `/rides`. It shows total distance planned, "Roughly N hours of riding," and an overall twistiness rating; Your stats against the average and top rider; What you stop for (category counts); Your records (longest route, biggest ride, twistiest 20 miles, most opened); rides planned per month for 12 months; Who can see them; and the Imported files meter. Only active alternates count.

## Explore and Near me

`/explore`, no sign-in needed. Tabs: Most viewed, Newest, Near me. Only Public rides appear. Near me lists Public rides whose road passes within 50 miles, nearest first, 24 at most, from the rider's home base if set, otherwise from "Use my location." A ride appears only after its road is drawn and saved. Any signed-in rider can open or clone a listed ride.

## The tour

"Take the tour" in the header or account menu (`/builder?tour`). It never starts on its own. Five parts, Route, Clock, Fuel, People, and Meet; every card has Next, Back, and skip; it plays like a video, typing and clicking for the rider. It builds a temporary private ride, "Coast run" (Oakland to Santa Cruz), with three guide riders (Sam Okafor, Priya Nair, Diego Reyes), spends no map calls, and deletes the ride outright on finish or close, or after a day if abandoned. Starting again replaces the previous one. Nothing is added to the rider's Paddock or bin. 

## Feedback

`/feedback` (account menu): Something's broken, I've got an idea, or I've got a question, then an area, details (3 to 4,000 characters), and up to 3 photos (JPEG, PNG, WebP, GIF, 4 MB each). Up to 10 reports an hour. Reports are private to the author and the site owner; ideas may be published to the board at `/board`, where riders mark the ones they want. "See what you've sent" is `/feedback/mine`. Status changes send Report updates.

## Storage and the bin

- Every rider has 100 MB for imported files; rides built in the builder take no storage, and neither do bike photos, avatars, or feedback photos. The dashboard's Imported files meter shows it; a warning comes at 90% and again only after dropping back under.
- Deleted rides, places, and place groups stay in the bin 30 days, then are destroyed. Binning a ride frees its storage at once. Restoring can be refused for storage or, for a place group, because a group by that name now exists. There is no "empty now."

## Account: download and delete

Preferences, GTFO:

- Download Me: one zip with the profile, Paddock, places, friends, and every ride in all formats plus original uploads; the `.routeloop.json` in each ride folder is the lossless one. 3 per hour; refused above 200 MB. Other people appear by handle, never email.
- Delete Me: type your email to confirm. Your profile, rides, and links disappear at once; the handle stays reserved; you can still sign in and download for 30 days, then everything is destroyed. Refused for the site owner and the last rider who can approve others.
- Save Me: on `/account/gone`, cancels the deletion. Signing in alone does not cancel it, whatever the warning message says.

## The beta

Routeloop is a free closed beta, no ads, accounts approved by hand. Sign in with Google or an emailed link (valid 15 minutes). A personal ride link skips the queue. Riders should keep copies of rides they would hate to lose.

## Before a trip: account settings to check

1. Paddock: every rider has a bike with Range in miles, and the right bike is the default or picked on the ride's Roster page. Without Range, fuel is not checked at all.
2. Preferences, Units: distance, date order, clock, and fuel volume read the way the rider thinks.
3. Preferences, Vocabulary: vehicle and power match the machine. Electricity switches fuel checks to chargers when that bike has the shortest range.
4. Preferences, Notifications: Email on for Votes, Comments, Suggestions, RSVPs, Added to a ride, Recycle bin, and Storage. Browser only works with a tab open and permission allowed.
5. Profile, Home base and Public starting point: set a public start before sharing any ride that starts at home.
6. Profile, Your public page: who can see the rider's page and whether the Paddock shows.
7. Preferences, Places and brands: avoid and favor lists for fuel searches.
8. Preferences, Meeting points: the default extra detour for group rides.
9. Rides page on the travel phone: On this phone set and downloaded, or Keep pressed on the trip, then tested in airplane mode.
10. Recycle bin tab: nothing needed is about to be destroyed.
11. GTFO, Download Me: a full backup before a long trip.
12. Robots: their own Anthropic or OpenAI key, or a Claude or ChatGPT connector, to plan with AI.
