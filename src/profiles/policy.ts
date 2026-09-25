// Who sees how much of a rider's public profile at /@handle. Pure, so the rule is
// tested without a database; routes/pages.tsx is the only caller.
//
//   full     avatar, bio, stats, socials (if shared), paddock (if shared), rides
//   minimal  name and handle only, plus the friend and follow buttons
//
// Minimal rather than a 404, because friendship emails and rosters link here and a
// rider who hides their page still has to be addable.

export const PROFILE_VISIBILITIES = ['public', 'members', 'hidden'] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number]

/** Also the column default, for the riders who have no profile row at all. */
export const DEFAULT_PROFILE_VISIBILITY: ProfileVisibility = 'members'

export const BIO_MAX = 280

export type ProfileDepth = 'full' | 'minimal'

export const isProfileVisibility = (v: unknown): v is ProfileVisibility =>
  typeof v === 'string' && (PROFILE_VISIBILITIES as readonly string[]).includes(v)

/** Anything unreadable becomes the default rather than an error. */
export const toProfileVisibility = (v: unknown): ProfileVisibility =>
  isProfileVisibility(v) ? v : DEFAULT_PROFILE_VISIBILITY

type Viewer = { id: number; status: string } | null

/** The owner always sees their full page, so they can check what others get. */
export function profileDepth(visibility: ProfileVisibility, ownerId: number, viewer: Viewer): ProfileDepth {
  if (viewer && viewer.id === ownerId) return 'full'
  if (visibility === 'public') return 'full'
  if (visibility === 'members') return viewer?.status === 'active' ? 'full' : 'minimal'
  return 'minimal'
}

/** Whether a bike photo may be served to this viewer: the same gate as the paddock. */
export const canSeePaddock = (
  visibility: ProfileVisibility,
  sharePaddock: boolean,
  ownerId: number,
  viewer: Viewer,
): boolean =>
  (viewer !== null && viewer.id === ownerId) ||
  (sharePaddock && profileDepth(visibility, ownerId, viewer) === 'full')

export const VISIBILITY_CHOICES: readonly { value: ProfileVisibility; label: string; hint: string }[] = [
  { value: 'public', label: 'Anyone', hint: 'Anyone with the link, signed in or not.' },
  { value: 'members', label: 'Riders', hint: 'Only people signed in to Routeloop.' },
  { value: 'hidden', label: 'Nobody', hint: 'Your name and handle only, so friends can still find you.' },
]
