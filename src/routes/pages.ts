// Public content pages: FAQ, privacy, terms.
//
// All three are readable signed out. That is a requirement rather than a
// preference for /privacy — Google's OAuth consent screen review fetches it
// without a session, and the consent screen cannot be published past its
// 100-user cap until it resolves.
//
// The FAQ copy is maintained in docs/ops/faq.md, which is the source of truth
// and carries the answers that are not publishable yet. Anything reworded here
// should go back to that file.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { rides, routes as routesTable, userProfiles, users } from '../db/schema'
import { esc, page, type NavKey } from '../views/layout'
import { rideCards } from '../views/cards'
import { requireActive, type AuthEnv } from '../auth/middleware'
import { allow, clientIp } from '../auth/ratelimit'

export const pageRoutes = new Hono<AuthEnv>()

// Both legal pages carry this. A date matters more than a version number to a
// reader deciding whether anything changed since they last looked.
const EFFECTIVE = '1 August 2026'

// Two spans that used to be written as the years they started, which quietly
// went stale every January. Stated as durations and worked out at render time
// instead. Computed on the server rather than in the browser so there is no
// flash of the wrong number and the page still reads correctly with JS off.
const yearsSince = (year: number): number => new Date().getFullYear() - year
const RIDING_YEARS = yearsSince(1999)
const WEB_YEARS = yearsSince(1993)

// One question, collapsed. <details> rather than a scripted accordion: the
// platform already gets the keyboard, the ARIA and find-in-page right, and a
// reader with no JS still sees every answer.
//
// The id is passed rather than slugged from the question, and that is
// deliberate. These ids are a public contract — other pages link to them (see
// faqLink in layout.ts) and so does anyone who shares a link. Deriving them
// from the wording would silently break every one of those the first time a
// question is rephrased.
const qa = (id: string, q: string, a: string): string => `
  <details class="qa" id="${id}">
    <summary>${q}</summary>
    <div class="qa-answer">${a}</div>
  </details>`

const faqBody = `<h1>Questions</h1>
<p class="lede">What TankBag is, what it is not, and what happens to your trips. If something is missing, ask—the list grows from what people actually want to know.</p>
<p class="faq-controls"><button type="button" class="linkbtn" data-faq-toggle-all aria-expanded="false">Expand all</button></p>

<h2>About the name</h2>
${qa(
  'tank-bag',
  "What's a tank bag?",
  `<p>A tank bag straps to the fuel tank of a motorcycle, right in front of the rider. Most of them have a clear pocket on top, and before GPS that pocket is where your route lived—a folded paper map, angled so you could read the next turn without stopping.</p>
   <p>That's the job this does. The bag held the plan. So does this.</p>`,
)}
${qa(
  'need-a-motorcycle',
  'Do I need a motorcycle to use this?',
  `<p>No. I built it for riding and it shows in the vocabulary, but a route is a route. A long trip with a lot of stops is the same problem on two wheels or four—where you're sleeping, how far you can go before fuel, which road is actually worth taking.</p>
   <p>The router is in car mode regardless. Google's motorcycle routing only works in a handful of Asian markets, so every route TankBag builds is already computed for four wheels.</p>`,
)}
${qa(
  'luggage-brands',
  'Is TankBag related to Nelson-Rigg, Givi, or any luggage brand?',
  `<p>No. A tank bag is a generic category of motorcycle luggage, the same way "backpack" is. The name is a nod to the object, not to anyone who makes them.</p>`,
)}

<h2>What it is</h2>
${qa(
  'is-it-navigation',
  'Is this a navigation app?',
  `<p>No. TankBag is for planning, organizing and sharing a trip before you leave, and for handing the finished plan to whatever you navigate with.</p>
   <p>You already have an app or a device you like, and you like it for reasons that are yours—how it handles with gloves on, how readable it is at speed, whether it sends you on side-quests when you just want to get somewhere. I'm not trying to talk you out of it. I'm trying to make it follow your plan.</p>`,
)}
${qa(
  'turn-by-turn',
  'Will it give me turn-by-turn directions?',
  `<p>No, and that's a decision rather than a gap.</p>
   <p>Turn-by-turn is a solved problem with several good answers already installed on your phone. What isn't solved is getting your actual plan into one of them intact. Doing both badly would be worse than doing one properly.</p>`,
)}
${qa(
  'gps-ignores-route',
  'Why does my GPS ignore the route I planned?',
  `<p>Because it isn't following your line—it's re-routing between your stops. Give a navigation app two points a long way apart and it picks its own way between them, usually the fast way and rarely the good one. Miss a turn and it can throw out the rest of the day.</p>
   <p>The fix is to leave it no room. Put enough intermediate points along the route and there's never a stretch long enough for the app to form an opinion. Doing that by hand is miserable, which is why TankBag does it for you.</p>`,
)}
${qa(
  'vs-google-maps',
  'How is this different from Google Maps?',
  `<p>Google My Maps caps at about ten waypoints and one route per layer, and you can't navigate from a custom map. Google Maps proper will reroute you onto whatever it considers efficient, which is rarely the road you wanted.</p>
   <p>TankBag gives you 200 stops a day across 31 days, no layers to fight, and no opinion about your route. Whatever you plan is visible on one map at once, all of it, however many days it runs.</p>`,
)}
${qa(
  'vs-other-planners',
  'How is this different from the other route planners?',
  `<p>Most of them are navigation apps with a planner bolted on, and the planning is usually fine. Where they fall down is the hand-off—the moment you dump a GPX into your device and it does something else entirely.</p>
   <p>That's the part TankBag is built around. Beyond it: stop counts in the hundreds rather than the low teens, the whole multi-day trip on one map instead of one route at a time, and share links that open for someone with no account.</p>`,
)}

<h2>Planning a trip</h2>
${qa(
  'limits',
  'How many stops, days or miles can one trip have?',
  `<p>Up to 31 days, 200 stops a day, and no cap on distance.</p>
   <p>Those are the real numbers, and I'd rather give you them than say "unlimited" and have you find the wall. A month of riding at two hundred stops a day is not a trip anyone takes—the caps exist so one runaway import can't take the site down, not to ration what you plan.</p>
   <p>For comparison: Google My Maps stops you at about ten waypoints.</p>`,
)}
${qa(
  'waypoint-poi-stop',
  "What's the difference between a waypoint, a POI and a stop?",
  `<p>Three kinds of dot, because they do three different jobs.</p>
   <ul>
     <li>A <strong>waypoint</strong> keeps the route on the road you meant. Nothing happens there, you don't stop, and it exists only to stop the router taking a different way round.</li>
     <li>A <strong>POI</strong> is something worth knowing about—a vista, a museum, a diner someone told you about. You might stop, you might not.</li>
     <li>A <strong>stop</strong> is a stop. Fuel, food, a night's sleep. Stops have a duration, because they take time out of the day.</li>
   </ul>
   <p>The distinction matters when the plan leaves TankBag: exports can carry stops and shaping points differently, and getting it wrong is how routes arrive on a GPS looking nothing like what you planned.</p>`,
)}
${qa(
  'stop-categories',
  'Can I say what kind of stop it is?',
  `<p>Yes. Seventeen roles—fuel, food, coffee, drinks, hotel, camp, grocery, viewpoint, meeting point and the rest—so a day reads at a glance instead of being seventeen identical pins.</p>
   <p>They earn their keep on export too: a stop tagged as fuel can be treated differently from a scenic detour by whatever you hand the file to.</p>`,
)}
${qa(
  'twistiness',
  'What does "Twisty" mean on my ride?',
  `<p>It's a rough measure of how much the road bends, worked out from the shape of your route.</p>
   <p>TankBag walks the line every 25 metres and adds up how far the direction changes. A road that runs dead straight adds nothing. A road that turns constantly adds a lot. Divide by the miles and you get one number, which becomes one of five words: <strong>Straight</strong>, <strong>Mostly straight</strong>, <strong>Some curves</strong>, <strong>Twisty</strong> or <strong>Very twisty</strong>. Hover the label to see the number behind it.</p>
   <p>It counts <em>bends</em>, not junctions. Turning left at a crossroads onto another straight road barely registers; a mountain pass that never stops curving registers a lot.</p>
   <p>A whole day gets averaged, which can be unfair to a good road—forty brilliant miles and two hundred of motorway average out to something dull. So the hover also tells you about the best twenty-mile stretch of the day, when that stretch is meaningfully better than the rest of it. That second number is usually the one worth paying attention to.</p>
   <p>Because it comes from the shape of the line and nothing else, it works on rides you imported as well as ones you built here.</p>`,
)}
${qa(
  'import-a-route',
  'Can I import a route I already have?',
  `<p>Yes—KML and GPX both.</p>
   <p>What you get back is an editable trip, not a picture of one. The file is pulled apart into stops and legs you can drag, rename, reorder and add days to. Most tools import a track as a single frozen line; if that's all you needed you could have kept the file.</p>`,
)}
${qa(
  'on-a-phone',
  'Can I plan on my phone?',
  `<p>It runs in a phone browser, and a shared trip reads fine on one. Building a multi-day route is a big-screen job today.</p>`,
)}
${qa(
  'outside-the-us',
  'Does it work outside the US?',
  `<p>The maps, search and routing are global, so in principle yes. Testing has been US-centric, so expect rougher edges elsewhere—and tell me when you find them.</p>`,
)}

<h2>Sharing</h2>
${qa(
  'share-without-account',
  "Can I share a trip with someone who doesn't have an account?",
  `<p>Yes. Every trip has a link, and public and unlisted links open for anyone—no account, no sign-up, no app to install. That's deliberate; a plan nobody can open isn't a plan.</p>`,
)}
${qa(
  'visibility',
  'Can I keep a trip private?',
  `<p>Yes, and it already is—every trip starts private and stays that way until you change it.</p>
   <p>Three settings, and the difference is who can find it rather than who can open it:</p>
   <ul>
     <li><strong>Private</strong>—only you.</li>
     <li><strong>Unlisted</strong>—anyone with the link, and it appears in no listing anywhere. This is the one to share with a group.</li>
     <li><strong>Public</strong>—the link works and the trip can show up in listings.</li>
   </ul>`,
)}

<h2>Your data</h2>
${qa(
  'what-happens-to-my-data',
  'What do you do with my location and trip data?',
  `<p>It stays yours, and it is not sold, shared or mined. The full account is on the <a href="/privacy">privacy page</a>; the short version:</p>
   <p>Your routes and stops are stored so the app can show them to you and to whoever you share a link with. Nothing else reads them. There is no advertising business here to feed them to.</p>
   <p>Two outside services see fragments in the course of doing their job: Google draws the map, finds the places you search for, and computes the roads between your stops; if you sign in by email, Gmail carries the link. Neither gets a copy of your trips.</p>`,
)}
${qa(
  'google-name',
  'Do you take my name from my Google account?',
  `<p>No. You pick your own name and handle when you sign up, and neither is inherited from Google.</p>
   <p>Google does hand over your first and last name when you sign in with it, and those land on your profile where only you can see them. They are not shown to anyone else unless you turn that on yourself.</p>`,
)}
${qa(
  'home-address',
  'What about my home address?',
  `<p>It is stored so new rides can start from your door without you searching for it every time, and it is shown to nobody but you. Not on shared trips, not on a profile, not to riders you plan with. You can leave it blank; the only thing you lose is that shortcut.</p>`,
)}

<h2>Access and status</h2>
${qa(
  'invites',
  'Why do I need an invite?',
  `<p>TankBag is in a closed alpha and accounts are approved by hand. That's not scarcity marketing—it's a small app run by one person, and letting it grow slowly is how it stays working.</p>`,
)}
${qa(
  'alpha-data-loss',
  "It's an alpha. Am I going to lose my trips?",
  `<p>Possibly. Expect rough edges, missing pieces and the occasional data reset. Anything you'd be upset to lose, export or keep a copy of.</p>`,
)}
${qa(
  'is-it-free',
  'Is it free?',
  `<p>Yes, and there is no paid plan and no advertising. If that ever has to change so the thing can keep running, I'll say so here before it does.</p>`,
)}
${qa(
  'who-builds-this',
  "Who's building this?",
  `<p>One person. I've been riding for ${RIDING_YEARS} years—hundreds of thousands of miles, most of them across the western US and Mexico—and building things for the web for ${WEB_YEARS} years.</p>
   <p>I built this because every planning tool I tried had the same shape: something clever I didn't need and couldn't turn off, sitting on top of something basic that didn't work. Stop times, waypoint counts, import and export that survives contact with a real device. I wanted the tool without the first part and with all of the second, so I'm making it.</p>`,
)}`

const privacyBody = `<h1>Privacy</h1>
<p class="lede">What TankBag stores, why, and who else sees it. Written to be read rather than to be defensible.</p>
<p class="effective">In effect ${EFFECTIVE}</p>

<h2>The short version</h2>
<ul>
  <li>Your trips are yours. They are not sold, shared, or used to build a profile of you.</li>
  <li>There is no advertising here, so there is nothing to feed.</li>
  <li>Nothing you did not choose is shown to anyone else. Your name, your handle and what appears on a shared trip are all yours to set.</li>
  <li>You can ask for a copy of everything, or for all of it to be deleted, and I will do it by hand until there is a button.</li>
</ul>

<h2>What is stored</h2>
<h3>Your account</h3>
<p>Your email address, the display name and username you chose, the dates you have held past usernames, and—if you signed in with Google—the account identifier Google issues for you. Sign-in tokens are stored as one-way hashes, so a copy of the database yields no usable logins.</p>

<h3>Your profile</h3>
<p>Anything you fill in: first and last name, home address and its coordinates, and payment handles for splitting costs on a trip. All of it is optional, all of it is shown only to you, and none of it appears on a shared trip unless you switch it on yourself.</p>
<p>If you sign in with Google, your first and last name are filled in from your Google account as a starting point. They are visible to you on your profile, where you can change or clear them, and to nobody else.</p>

<h3>Your trips</h3>
<p>The routes, stops, notes and coordinates you enter, plus how many times a shared trip has been opened. If you upload a KML or GPX file, the original is kept so it can be downloaded again.</p>

<h3>Technical</h3>
<p>Your IP address is used briefly to rate-limit sign-in emails, so the form cannot be used to flood someone's inbox. There are no analytics, no tracking pixels, and no third-party cookies. The only cookie is the one that keeps you signed in.</p>

<h2>Who else sees it</h2>
<p>Four services are involved in running the app. None of them is sent your trips as a body of data.</p>
<ul>
  <li><strong>Google Maps, Places and Routes</strong> draw the map, answer your place searches, and work out the roads between two stops. That means Google sees the search terms you type and the coordinates it is asked to route between, in the moment it is asked.</li>
  <li><strong>Google Sign-In</strong>, if you use it, tells TankBag your email address, whether Google has verified it, and your first and last name. Nothing else is requested.</li>
  <li><strong>Gmail</strong> carries the sign-in email if you use a magic link instead.</li>
  <li><strong>Cloudflare</strong> passes traffic between the internet and the server.</li>
</ul>
<p>The application and its database run on hardware I own and administer. Your trips are not held by a cloud provider.</p>

<h2>What is public</h2>
<p>Only what you decide. Every trip starts private. Unlisted means anyone with the link can open it but it is listed nowhere. Public means it can also appear in listings on the site.</p>
<p>A shared trip shows the trip: its routes, stops and notes. It does not show your email, your address, or anything on your profile you have not chosen to share.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>See it</strong>—your profile and trips are readable in the app at any time.</li>
  <li><strong>Change it</strong>—everything on your profile is editable, including clearing fields you would rather not store.</li>
  <li><strong>Take it</strong>—ask and I will send you a copy of your account and trips.</li>
  <li><strong>Delete it</strong>—ask and your account and everything attached to it is removed. There is no self-service button yet; until there is, one email does it.</li>
</ul>

<h2>How long things are kept</h2>
<p>Your account and trips are kept until you delete them or ask me to. Sign-in links expire in fifteen minutes and are single-use. Rate-limiting records are held for an hour and then discarded.</p>

<h2>Children</h2>
<p>TankBag is not intended for anyone under 13, and accounts are approved by hand.</p>

<h2>Changes</h2>
<p>If this page changes in a way that affects what is collected or who sees it, the date above changes and I will say what moved. Silent rewrites defeat the point of publishing it.</p>

<h2>Asking</h2>
<p>Questions, requests for a copy of your data, or a deletion request all go to the same place: <a href="https://github.com/feralcreative/tankbag/issues">the issue tracker</a> for anything public, or the contact route you signed up through for anything that should not be.</p>`

const termsBody = `<h1>Terms</h1>
<p class="lede">The agreement for using TankBag. Short, because a small app run by one person does not need a long one.</p>
<p class="effective">In effect ${EFFECTIVE}</p>

<h2>What this is</h2>
<p>TankBag is a tool for planning, organizing and sharing road trips. It is not a navigation system and must not be relied on as one. It is currently in a closed alpha, which means accounts are approved by hand and things will break.</p>

<h2>Your account</h2>
<p>You need an account to plan a trip, and accounts are approved individually. Keep your sign-in to yourself; anything done through your account is treated as done by you. Tell me if you think someone else has got into it.</p>
<p>Pick a username that is yours to pick. Impersonating someone else, or claiming a handle to sit on it, is grounds for it being taken back.</p>

<h2>Your content</h2>
<p><strong>Your trips are yours.</strong> Planning a route here does not give me any ownership of it. What you upload, type and plan stays yours.</p>
<p>You give me only the permission needed to run the service: to store your content, and to show it to you and to anyone you share a link with. That permission ends when you delete the content or the account.</p>
<p>Do not upload anything you do not have the right to upload, and do not use TankBag to store or share anything unlawful.</p>

<h2>Riding is your responsibility</h2>
<p>This is the part that actually matters on a motorcycle.</p>
<p>Routes are computed from map data that is sometimes wrong, sometimes out of date, and never aware of what the road is doing today. Roads close. Bridges wash out. A track that looks paved on a map can be gravel, or private, or gone. Distances and times are estimates, and estimates for a car at that.</p>
<p><strong>Judgement on the road is yours alone.</strong> Check conditions before you go, ride within the law and your ability, and do not follow a line off a screen into something you can see is a bad idea. TankBag plans trips; it does not know what the weather is doing or what your tyres can take.</p>

<h2>What I promise, and what I do not</h2>
<p>I run this carefully and use it for my own trips, which is the best guarantee I can offer. But it is an alpha provided as-is: no uptime promise, no guarantee that a feature will still exist next month, and no warranty of any kind.</p>
<p><strong>Keep your own copies of anything you would be upset to lose.</strong> Data loss is unlikely but possible, and the alpha notice says so for a reason.</p>
<p>To the extent the law allows, I am not liable for losses arising from using TankBag—including a trip that went wrong, a plan that did not survive the hand-off to a device, or data that went missing.</p>

<h2>Fair use</h2>
<p>Do not scrape the site, hammer the API, or use TankBag in a way that degrades it for anyone else. The limits in the app—days per trip, stops per day—are there to keep it standing, not to be worked around.</p>

<h2>Ending it</h2>
<p>You can stop using TankBag whenever you like and ask for your account to be deleted. I can suspend an account that breaks these terms or puts the service at risk, and for anything short of abuse I will tell you why first.</p>

<h2>Changes</h2>
<p>These terms can change as the app does. The date above moves when they do, and material changes get said out loud rather than slipped in.</p>

<h2>Getting in touch</h2>
<p>Questions about any of this go to <a href="https://github.com/feralcreative/tankbag/issues">the issue tracker</a>, or the contact route you signed up through.</p>`

const render = (c: Context, title: string, body: string, bodyClass: string, navKey?: NavKey) =>
  c.html(page({ title, user: c.get('user') ?? null, bodyClass, body, navKey }))

// Browsable gallery of public rides.
//
// Paged rather than unbounded: this is the one query in the app whose row count
// grows with the whole userbase rather than with one rider's data, so a bare
// SELECT here is a slow page the day it matters. 24 a page, offset paging —
// keyset would be better under real load but needs a stable tiebreak, and at
// alpha scale offset is honest and simple.
const PER_PAGE = 24

pageRoutes.get('/explore', async (c) => {
  const sort = c.req.query('sort') === 'new' ? 'new' : 'popular'
  const page_ = Math.max(1, Number(c.req.query('page') ?? 1) || 1)
  const offset = (page_ - 1) * PER_PAGE

  const order = sort === 'new' ? [desc(rides.createdAt)] : [desc(rides.viewCount), desc(rides.createdAt)]

  // One extra row answers "is there a next page" without a second count query.
  const rows = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(eq(rides.visibility, 'public'))
    .orderBy(...order)
    .limit(PER_PAGE + 1)
    .offset(offset)

  const hasNext = rows.length > PER_PAGE
  const cards = rows.slice(0, PER_PAGE)

  const tab = (key: string, label: string) =>
    `<a class="explore-tab${sort === key ? ' is-on' : ''}" href="/explore?sort=${key}">${label}</a>`
  const pageLink = (n: number, label: string) =>
    `<a class="explore-page" href="/explore?sort=${sort}&page=${n}">${label}</a>`

  const body = `<h1>Explore</h1>
<p class="lede">Public rides other people have planned. Open one, or clone it as a starting point for your own.</p>
<nav class="explore-tabs">${tab('popular', 'Most viewed')}${tab('new', 'Newest')}</nav>
${rideCards(cards, sort === 'popular')}
<nav class="explore-pager">
  ${page_ > 1 ? pageLink(page_ - 1, '← Newer page') : ''}
  ${hasNext ? pageLink(page_ + 1, 'Older page →') : ''}
</nav>`

  return render(c, 'Explore', body, 'content-page explore-page', 'explore')
})

// The rider roster.
//
// Shows exactly what a public profile shows and nothing more — display name and
// handle — because it is the same question asked in bulk. Anything a rider has
// not chosen to publish stays off both. In particular no email, which is what
// separates this from /admin.
//
// Signed-in only. That is not because the data is sensitive (it is all on the
// public profiles already) but because an anonymous bulk list of every account
// is a scraping target with no upside.
pageRoutes.get('/riders', requireActive, async (c) => {
  if (!allow('roster', clientIp(c.req.raw.headers), { max: 60 })) {
    return c.text('Slow down a moment.', 429)
  }

  const q = (c.req.query('q') ?? '').trim().slice(0, 30)

  const rows = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(
      q
        ? sql`${users.status} = 'active' and ${users.username} is not null
              and (lower(${users.username}) like lower(${'%' + q + '%'})
                   or lower(${users.displayName}) like lower(${'%' + q + '%'}))`
        : sql`${users.status} = 'active' and ${users.username} is not null`,
    )
    .orderBy(users.displayName)
    .limit(200)

  const list = rows.length
    ? `<ul class="rider-list">${rows
        .map(
          (r) =>
            `<li><a href="/@${esc(r.username!)}"><span class="rider-display">${esc(r.displayName)}</span><span class="rider-handle">@${esc(r.username!)}</span></a></li>`,
        )
        .join('')}</ul>`
    : '<p class="empty">Nobody matches that.</p>'

  const body = `<h1>Riders</h1>
<p class="lede">Everyone planning here. Names and handles only &mdash; anything else is on a rider's own profile, and only if they put it there.</p>
<form class="rider-search" method="get" action="/riders">
  <label class="visually-hidden" for="rider-q">Search riders</label>
  <input id="rider-q" name="q" type="search" maxlength="30" placeholder="Search by name or handle" value="${esc(q)}">
  <button class="btn" type="submit">Search</button>
</form>
${list}`

  return render(c, 'Riders', body, 'content-page riders-page', 'riders')
})

// Public rider profile at /@handle.
//
// What appears here is the whole privacy decision made visible, so the rule is
// written as one list rather than scattered through the template:
//
//   shown        username, display name, public rides
//   opt-in       last name, and only via share_last_name
//   never        first name, email, home address, coordinates, payment handles
//
// Payment handles are "never" rather than "opt-in" on purpose. They are for
// settling up with people you are actually riding with, which is a relationship
// this app does not model yet (#12). A handle on a public page is a payment
// request open to strangers.
// Hono does not match `/@:username` — a literal prefix in front of a param is
// not something its router handles, and the route simply never fires. A regex
// param does work, and pinning the charset to the username rule means a bad
// handle 404s at the router instead of reaching a query.
pageRoutes.get('/:handle{@[A-Za-z0-9_]{3,30}}', async (c) => {
  const handle = c.req.param('handle').slice(1) // drop the @
  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      status: users.status,
      lastName: userProfiles.lastName,
      shareLastName: userProfiles.shareLastName,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(sql`lower(${users.username}) = lower(${handle})`)
    .limit(1)

  // A pending or blocked account has no public presence. Same 404 as a handle
  // that was never claimed, so the page cannot be used to probe account states.
  if (!row?.username || row.status !== 'active') return c.text('Not found', 404)

  const cards = await db
    .select({ ride: rides, color: routesTable.color })
    .from(rides)
    .leftJoin(routesTable, and(eq(routesTable.rideId, rides.id), eq(routesTable.position, 0)))
    .where(and(eq(rides.ownerId, row.id), eq(rides.visibility, 'public')))
    .orderBy(desc(rides.viewCount), desc(rides.createdAt))
    .limit(50)

  const surname = row.shareLastName && row.lastName ? ` ${esc(row.lastName)}` : ''
  const body = `<h1 class="profile-name">${esc(row.displayName)}${surname}</h1>
<p class="profile-handle">@${esc(row.username)}</p>
<h2>Public rides</h2>
${rideCards(cards)}`

  return render(c, row.displayName, body, 'content-page profile-page')
})

pageRoutes.get('/faq', (c) => render(c, 'Questions', faqBody, 'content-page faq-page'))
pageRoutes.get('/privacy', (c) => render(c, 'Privacy', privacyBody, 'content-page'))
pageRoutes.get('/terms', (c) => render(c, 'Terms', termsBody, 'content-page'))
