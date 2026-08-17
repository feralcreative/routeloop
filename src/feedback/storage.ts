// Attachment files on disk, following the src/maps/storage.ts convention:
// integer ids only, containment-checked against the storage root, so path
// traversal is structurally impossible and the check is belt and braces.
//
// Lives under `{STORAGE}/feedback/{reportId}/{index}.{ext}`. The `feedback`
// segment cannot collide with a rider directory because those are named by
// integer owner id.
//
// **These bytes are counted in feedback_attachments.bytes and NOWHERE else.**
// They must stay out of rides.size_bytes and users.used_bytes: an attachment is
// not ride data, it must not eat a rider's 25 MB, and adding a fourth byte
// column to that generated expression would corrupt quota accounting on every
// ride delete.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { STORAGE } from '../maps/storage'

const ROOT = resolve(STORAGE, 'feedback')

/** A closed list, because the extension is the only part of the path not derived
 *  from an integer. Matches what the intake's file input accepts. */
export const ATTACHMENT_EXTS = ['jpg', 'png', 'webp', 'gif'] as const
export type AttachmentExt = (typeof ATTACHMENT_EXTS)[number]

/** What the client is allowed to send, and what each becomes on disk. A HEIC
 *  from an iPhone arrives as JPEG because the canvas downscale in feedback.js
 *  re-encodes it; a rider with that step broken gets a clear refusal instead of
 *  a file nothing can open. */
export const MIME_EXT: Record<string, AttachmentExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** After the client-side downscale to 1600px on the long edge, a screenshot is
 *  well under this. The cap is what stops an un-downscaled 12 MB original — the
 *  exact case where JavaScript failed and the form still worked. */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024

const MAX_PER_REPORT = 3

export function attachmentPath(reportId: number, index: number, ext: AttachmentExt): string | undefined {
  if (!Number.isInteger(reportId) || reportId <= 0) return undefined
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PER_REPORT) return undefined
  if (!ATTACHMENT_EXTS.includes(ext)) return undefined
  const path = resolve(ROOT, String(reportId), `${index}.${ext}`)
  if (!path.startsWith(ROOT + sep)) return undefined
  return path
}

/** The value stored in feedback_attachments.storage_key: relative to STORAGE, so
 *  moving the root is a config change rather than a data migration. */
export function attachmentKey(reportId: number, index: number, ext: AttachmentExt): string {
  return `feedback/${reportId}/${index}.${ext}`
}

/** Resolve a stored key back to an absolute path, refusing anything that escapes
 *  the root. The key comes out of the database, which is not the same as
 *  trusting it — a hand-edited row must not read /etc/passwd. */
export function pathForKey(key: string): string | undefined {
  if (!/^feedback\/\d+\/\d+\.[a-z]+$/.test(key)) return undefined
  const path = resolve(STORAGE, key)
  return path.startsWith(ROOT + sep) ? path : undefined
}

// 0640: readable by the app and its group, nobody else. Same as writeMapFile.
export async function writeAttachment(
  reportId: number,
  index: number,
  ext: AttachmentExt,
  data: Buffer,
): Promise<string> {
  const path = attachmentPath(reportId, index, ext)
  if (!path) throw new Error(`refusing to write outside the feedback storage root (report ${reportId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
  return attachmentKey(reportId, index, ext)
}

/** Best-effort cleanup after a rollback or a row delete, where a missing file is
 *  not an error. Removes the directory rather than the files it can name,
 *  because a rollback happens exactly when the rows that would say which files
 *  exist are gone. */
export async function deleteAttachments(reportId: number): Promise<void> {
  if (!Number.isInteger(reportId) || reportId <= 0) return
  const dir = resolve(ROOT, String(reportId))
  if (!dir.startsWith(ROOT + sep)) return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Report ids that have a directory on disk. Used by the orphan sweep — the
 *  cascade deletes rows, and nothing deletes files. */
export async function listAttachmentDirs(): Promise<number[]> {
  const names = await readdir(ROOT).catch(() => [] as string[])
  return names.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0)
}

export { MAX_PER_REPORT }
