// Clubs (#182): the club pages, their verbs, and the admin's club tools.
//
// Signed-in riders only, like /riders: a club page names its members, and an
// anonymous list of who rides with whom is not something to publish. Every
// verb re-reads the club and the actor's standing and asks ./clubs/policy.ts.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { users, type ClubRow } from '../db/schema'
import { currentUser, requireActive, requireManageRiders, requireSameOrigin, type AuthEnv } from '../auth/middleware'
import { page, avatarSrc, initialsOf } from '../views/layout'
import {
  MAX_CHAPTER_NAME,
  MAX_CLUB_NAME,
  POSITIONS,
  POSITION_LABEL,
  canEdit,
  canLeave,
  canManageRoster,
  canRemove,
  canRequest,
  cleanName,
  isManager,
  isPosition,
  type Standing,
} from '../clubs/policy'
import {
  acceptMember,
  addChapter,
  addMember,
  chaptersOf,
  clearClubIcon,
  clubById,
  createClub,
  leaveClub,
  listClubs,
  readClubIcon,
  removeChapter,
  removeMember,
  renameClub,
  requestToJoin,
  rosterOf,
  setClubIcon,
  setManager,
  setOwnChapter,
  setPosition,
  standingOf,
  type RosterEntry,
} from '../clubs/service'
import { viewOf } from '../friends/service'
import { checkUpload, MAX_IMAGE_BYTES, UPLOAD_REFUSAL_MESSAGES } from '../images/policy'
import { PROCESSED_MIME, processImage } from '../images/process'

export const clubRoutes = new Hono<AuthEnv>()

const ICON_BOX = { width: 512, height: 512 }
const idOf = (v: string | undefined): number | null => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** An active rider by handle, or null. The roster's own predicate. */
async function riderByHandle(raw: unknown): Promise<number | null> {
  const handle = typeof raw === 'string' ? raw.trim().replace(/^@/, '') : ''
  if (!handle) return null
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.username}) = lower(${handle})`,
        eq(users.status, 'active'),
        sql`${users.deletionRequestedAt} is null`,
        eq(users.isGuide, false),
      ),
    )
    .limit(1)
  return row?.id ?? null
}

/** Loads the club and the actor's standing, or null for a 404. */
async function load(c: Context<AuthEnv>): Promise<{ club: ClubRow; me: number; standing: Standing } | null> {
  const id = idOf(c.req.param('id'))
  const club = id ? await clubById(id) : null
  if (!club) return null
  const me = currentUser(c).id
  return { club, me, standing: await standingOf(club.id, me) }
}

const back = (club: ClubRow, note?: string) => `/clubs/${club.id}${note ? `?note=${encodeURIComponent(note)}` : ''}`

const Face = ({ r }: { r: RosterEntry }) => {
  const src = avatarSrc(r)
  return src ? (
    <img class="rider-face" src={src} alt="" loading="lazy" />
  ) : (
    <span class="rider-face is-initials" aria-hidden="true">
      {initialsOf(r.displayName) || '?'}
    </span>
  )
}

const Verb = ({ action, label, quiet, children }: { action: string; label: string; quiet?: boolean; children?: unknown }) => (
  <form method="post" action={action} class="club-verb">
    {children}
    <button type="submit" class={quiet ? 'btn-quiet' : 'btn btn-sm'}>
      {label}
    </button>
  </form>
)

// --- Pages -----------------------------------------------------------------

clubRoutes.get('/clubs', requireActive, async (c) => {
  const user = currentUser(c)
  const list = await listClubs()
  const body = (
    <>
      <h1>Clubs</h1>
      <p class="lede">
        A club is set up by the Routeloop admin with one manager, who admits its members. Ask to join from a club’s&nbsp;page.
      </p>
      {list.length ? (
        <ul class="cards club-list">
          {list.map((k) => (
            <li>
              <a href={`/clubs/${k.id}`}>
                {k.hasIcon ? <img class="club-icon" src={`/clubs/${k.id}/icon`} alt="" /> : <span class="club-icon is-blank" />}
                <strong>{k.name}</strong>
                <span>
                  {k.members} member{k.members === 1 ? '' : 's'}
                  {k.managed ? '' : ' · not taking new members'}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p class="empty">No clubs yet.</p>
      )}
    </>
  ).toString()
  return c.html(page({ title: 'Clubs', user, bodyClass: 'content-page clubs-page', body, navKey: 'riders' }))
})

clubRoutes.get('/clubs/:id', requireActive, async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  const { club, me, standing } = got
  const [roster, chapters] = await Promise.all([rosterOf(club.id), chaptersOf(club.id)])
  const members = roster.filter((r) => r.status === 'member')
  const requests = roster.filter((r) => r.status === 'requested')
  const edits = canEdit(club, me, standing)
  const manages = canManageRoster(club, me)
  const chapterName = new Map(chapters.map((ch) => [ch.id, ch.name]))
  const mine = roster.find((r) => r.id === me)
  const note = c.req.query('note')
  const user = currentUser(c)

  const body = (
    <>
      <header class="club-head">
        {club.iconBytes > 0 ? <img class="club-icon is-large" src={`/clubs/${club.id}/icon?v=${club.iconBytes}`} alt="" /> : null}
        <div>
          <h1>{club.name}</h1>
          <p class="lede">
            {members.length} member{members.length === 1 ? '' : 's'}
            {club.managerId == null ? ' · No manager right now, so nobody new can join. Ask the Routeloop admin to appoint one.' : ''}
          </p>
        </div>
      </header>
      {note && <p class="notice">{note}</p>}

      <div class="club-acts">
        {canRequest(club, me, standing) && <Verb action={`/clubs/${club.id}/request`} label="Ask to join" />}
        {standing === 'requested' && <p class="club-state">Your request is waiting on the club’s&nbsp;manager.</p>}
        {canLeave(club, me, standing) && (
          <Verb action={`/clubs/${club.id}/leave`} label={standing === 'requested' ? 'Withdraw request' : 'Leave club'} quiet />
        )}
        {isManager(club, me) && <p class="club-state">You manage this club’s roster.</p>}
      </div>

      {standing === 'member' && chapters.length > 0 && (
        <Verb action={`/clubs/${club.id}/my-chapter`} label="Save" quiet>
          <label>
            Your chapter{' '}
            <select name="chapter">
              <option value="">None</option>
              {chapters.map((ch) => (
                <option value={String(ch.id)} selected={mine?.chapterId === ch.id}>
                  {ch.name}
                </option>
              ))}
            </select>
          </label>
        </Verb>
      )}

      <h2>Members</h2>
      <ul class="club-roster">
        {members.map((r) => (
          <li>
            <a class="rider-card-who" href={`/@${r.username}`}>
              <Face r={r} />
              <span class="rider-card-name">
                <span class="rider-display">{r.displayName}</span>
                <span class="rider-handle">
                  @{r.username}
                  {r.position !== 'member' ? ` · ${POSITION_LABEL[r.position]}` : ''}
                  {r.chapterId ? ` · ${chapterName.get(r.chapterId) ?? ''}` : ''}
                  {club.managerId === r.id ? ' · Manager' : ''}
                </span>
              </span>
            </a>
            {manages && (
              <div class="club-row-acts">
                <Verb action={`/clubs/${club.id}/members/${r.id}/position`} label="Set" quiet>
                  <select name="position" aria-label={`Position for ${r.displayName}`}>
                    {POSITIONS.map((p) => (
                      <option value={p} selected={r.position === p}>
                        {POSITION_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </Verb>
                {canRemove(club, me, r.id) && <Verb action={`/clubs/${club.id}/members/${r.id}/remove`} label="Remove" quiet />}
              </div>
            )}
          </li>
        ))}
      </ul>

      {manages && (
        <section class="club-manage">
          <h2>Waiting to join</h2>
          {requests.length ? (
            <ul class="club-roster">
              {requests.map((r) => (
                <li>
                  <a class="rider-card-who" href={`/@${r.username}`}>
                    <Face r={r} />
                    <span class="rider-card-name">
                      <span class="rider-display">{r.displayName}</span>
                      <span class="rider-handle">@{r.username}</span>
                    </span>
                  </a>
                  <div class="club-row-acts">
                    <Verb action={`/clubs/${club.id}/members/${r.id}/accept`} label="Admit" />
                    <Verb action={`/clubs/${club.id}/members/${r.id}/remove`} label="Decline" quiet />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p class="empty">Nobody is waiting.</p>
          )}
          <Verb action={`/clubs/${club.id}/add`} label="Add">
            <label>
              Add a friend by handle <input name="handle" maxlength={31} autocomplete="off" placeholder="@handle" />
            </label>
          </Verb>
        </section>
      )}

      {edits && (
        <section class="club-edit">
          <h2>The club</h2>
          <p class="field-hint">Every member can change these.</p>
          <Verb action={`/clubs/${club.id}/name`} label="Rename">
            <label>
              Name <input name="name" maxlength={MAX_CLUB_NAME} value={club.name} required />
            </label>
          </Verb>
          <h3>Chapters</h3>
          <ul class="club-chapters">
            {chapters.map((ch) => (
              <li>
                {ch.name} <Verb action={`/clubs/${club.id}/chapters/${ch.id}/remove`} label="Remove" quiet />
              </li>
            ))}
          </ul>
          <Verb action={`/clubs/${club.id}/chapters`} label="Add chapter">
            <label>
              New chapter <input name="name" maxlength={MAX_CHAPTER_NAME} required />
            </label>
          </Verb>
          <h3>Icon</h3>
          <form method="post" action={`/clubs/${club.id}/icon`} enctype="multipart/form-data" class="club-verb">
            <input type="file" name="icon" accept="image/jpeg,image/png" required />
            <button type="submit" class="btn btn-sm">
              Upload
            </button>
          </form>
          {club.iconBytes > 0 && <Verb action={`/clubs/${club.id}/icon/remove`} label="Remove icon" quiet />}
        </section>
      )}
    </>
  ).toString()
  return c.html(page({ title: club.name, user, bodyClass: 'content-page club-page', body, navKey: 'riders' }))
})

clubRoutes.get('/clubs/:id/icon', requireActive, async (c) => {
  const id = idOf(c.req.param('id'))
  const data = id ? await readClubIcon(id) : null
  if (!data) return c.notFound()
  c.header('Content-Type', PROCESSED_MIME)
  c.header('Cache-Control', 'private, max-age=3600')
  return c.body(new Uint8Array(data))
})

// --- Verbs -------------------------------------------------------------------

const post = (path: string, handler: (c: Context<AuthEnv>) => Promise<Response>) =>
  clubRoutes.post(path, requireActive, requireSameOrigin, handler)

post('/clubs/:id/request', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  if (canRequest(got.club, got.me, got.standing)) await requestToJoin(got.club.id, got.me)
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/leave', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  if (canLeave(got.club, got.me, got.standing)) await leaveClub(got.club.id, got.me)
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/my-chapter', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  if (got.standing === 'member') {
    const form = await c.req.parseBody()
    await setOwnChapter(got.club.id, got.me, idOf(String(form.chapter ?? '')))
  }
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/name', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  const name = cleanName((await c.req.parseBody()).name, MAX_CLUB_NAME)
  if (canEdit(got.club, got.me, got.standing) && name) await renameClub(got.club.id, name)
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/chapters', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  const name = cleanName((await c.req.parseBody()).name, MAX_CHAPTER_NAME)
  if (canEdit(got.club, got.me, got.standing) && name) await addChapter(got.club.id, name)
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/chapters/:cid/remove', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  const cid = idOf(c.req.param('cid'))
  if (canEdit(got.club, got.me, got.standing) && cid) await removeChapter(got.club.id, cid)
  return c.redirect(back(got.club), 303)
})

clubRoutes.post(
  '/clubs/:id/icon',
  requireActive,
  requireSameOrigin,
  bodyLimit({ maxSize: MAX_IMAGE_BYTES * 2, onError: (c) => c.text('That image is too large.', 413) }),
  async (c) => {
    const got = await load(c)
    if (!got) return c.notFound()
    if (!canEdit(got.club, got.me, got.standing)) return c.redirect(back(got.club), 303)
    const file = (await c.req.parseBody().catch(() => null))?.icon
    if (!(file instanceof File)) return c.redirect(back(got.club, 'No image was sent.'), 303)
    const raw = new Uint8Array(await file.arrayBuffer())
    const check = checkUpload(raw)
    if (!check.ok) return c.redirect(back(got.club, UPLOAD_REFUSAL_MESSAGES[check.reason]), 303)
    let processed
    try {
      processed = await processImage(Buffer.from(raw), ICON_BOX)
    } catch {
      return c.redirect(back(got.club, 'That image could not be read.'), 303)
    }
    await setClubIcon(got.club.id, processed.data)
    return c.redirect(back(got.club), 303)
  },
)

post('/clubs/:id/icon/remove', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  if (canEdit(got.club, got.me, got.standing)) await clearClubIcon(got.club.id)
  return c.redirect(back(got.club), 303)
})

post('/clubs/:id/members/:uid/:verb{accept|remove|position}', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  const target = idOf(c.req.param('uid'))
  if (!target || !canManageRoster(got.club, got.me)) return c.redirect(back(got.club), 303)
  const verb = c.req.param('verb')
  if (verb === 'accept') await acceptMember(got.club.id, target)
  else if (verb === 'remove' && canRemove(got.club, got.me, target)) await removeMember(got.club.id, target)
  else if (verb === 'position') {
    const pos = (await c.req.parseBody()).position
    if (isPosition(pos)) await setPosition(got.club.id, target, pos)
  }
  return c.redirect(back(got.club), 303)
})

// The manager adds a FRIEND directly, the ride roster's rule: a friend already
// has an approved account and already chose to know them. Anyone else asks.
post('/clubs/:id/add', async (c) => {
  const got = await load(c)
  if (!got) return c.notFound()
  if (!canManageRoster(got.club, got.me)) return c.redirect(back(got.club), 303)
  const target = await riderByHandle((await c.req.parseBody()).handle)
  if (!target || (await viewOf(got.me, target)) !== 'friends')
    return c.redirect(back(got.club, 'You can add a friend directly. Anyone else can ask to join from this page.'), 303)
  await addMember(got.club.id, target)
  return c.redirect(back(got.club), 303)
})

// --- Admin: creating a club and passing the torch ------------------------------

clubRoutes.get('/admin/clubs', requireManageRiders, async (c) => {
  const user = currentUser(c)
  const list = await listClubs()
  const note = c.req.query('note')
  const body = (
    <>
      <h1>Clubs</h1>
      <p class="lede">Create a club and name its manager. Changing the manager here is how the torch passes.</p>
      {note && <p class="notice">{note}</p>}
      <form method="post" action="/admin/clubs" class="profile-form">
        <fieldset>
          <legend>New club</legend>
          <label>
            Name <input name="name" maxlength={MAX_CLUB_NAME} required />
          </label>
          <label>
            Manager’s handle <input name="manager" maxlength={31} placeholder="@handle" autocomplete="off" />
          </label>
          <button type="submit" class="btn">
            Create club
          </button>
        </fieldset>
      </form>
      <ul class="cards">
        {list.map((k) => (
          <li>
            <a href={`/clubs/${k.id}`}>
              <strong>{k.name}</strong>
            </a>
            <form method="post" action={`/admin/clubs/${k.id}/manager`} class="club-verb">
              <label>
                Manager <input name="manager" maxlength={31} placeholder="@handle, or blank for none" autocomplete="off" />
              </label>
              <button type="submit" class="btn-quiet">
                Set manager
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  ).toString()
  return c.html(page({ title: 'Clubs', user, navKey: 'admin', body }))
})

clubRoutes.post('/admin/clubs', requireManageRiders, requireSameOrigin, async (c) => {
  const form = await c.req.parseBody()
  const name = cleanName(form.name, MAX_CLUB_NAME)
  if (!name) return c.redirect('/admin/clubs?note=' + encodeURIComponent('A club needs a name.'), 303)
  const manager = String(form.manager ?? '').trim() ? await riderByHandle(form.manager) : null
  if (String(form.manager ?? '').trim() && manager == null)
    return c.redirect('/admin/clubs?note=' + encodeURIComponent('No active rider has that handle.'), 303)
  const id = await createClub(name, manager)
  return c.redirect(`/clubs/${id}`, 303)
})

clubRoutes.post('/admin/clubs/:id/manager', requireManageRiders, requireSameOrigin, async (c) => {
  const id = idOf(c.req.param('id'))
  const club = id ? await clubById(id) : null
  if (!club) return c.notFound()
  const raw = String((await c.req.parseBody()).manager ?? '').trim()
  const manager = raw ? await riderByHandle(raw) : null
  if (raw && manager == null) return c.redirect('/admin/clubs?note=' + encodeURIComponent('No active rider has that handle.'), 303)
  await setManager(club.id, manager)
  return c.redirect('/admin/clubs?note=' + encodeURIComponent(`${club.name}: manager updated.`), 303)
})
