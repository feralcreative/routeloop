// User-file storage, outside the web root. Paths are built only from integer
// ids ({STORAGE}/{ownerId}/{mapId}.{ext}) and containment-checked against the
// root — path traversal is structurally impossible, the check is belt and
// braces.
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const STORAGE = resolve(process.env.STORAGE_PATH ?? './moto-storage')

// The extensions a stored original can have. Deliberately a closed list rather
// than `string`: the extension is the only part of the path not derived from an
// integer id, so keeping it to values chosen here is what makes the containment
// check below a second line of defense rather than the only one.
//
// A KMZ is not here because one is never stored as an archive — the KML is
// pulled out and stored as `.kml`. `rides.source_format` is what remembers the
// ride arrived zipped.
export const STORED_EXTS = ['kml', 'gpx', 'geojson', 'csv', 'json'] as const
export type StoredExt = (typeof STORED_EXTS)[number]

// A ride imported from several files keeps each one. `index` is the day's
// position, so day 2 of a folder import lands at `{mapId}-1.gpx`. Day 0 keeps
// the bare `{mapId}.{ext}` name, which is what every single-file import has
// always written and what the rows already on disk are called.
const MAX_SOURCE_FILES = 30

// Returns the absolute path for a map file, or undefined if it would somehow
// escape the storage root. Both components are integers and the extension comes
// from a closed list, so there is nothing here for a caller to inject.
export function mapFilePath(ownerId: number, mapId: number, ext: StoredExt, index = 0): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SOURCE_FILES) return undefined
  const name = index === 0 ? `${mapId}.${ext}` : `${mapId}-${index}.${ext}`
  const path = resolve(STORAGE, String(ownerId), name)
  if (path !== STORAGE && !path.startsWith(STORAGE + sep)) return undefined
  return path
}

// 0640: readable by the app and its group, nobody else.
export async function writeMapFile(
  ownerId: number,
  mapId: number,
  ext: StoredExt,
  data: string | Buffer,
  index = 0,
): Promise<void> {
  const path = mapFilePath(ownerId, mapId, ext, index)
  if (!path) throw new Error(`refusing to write outside storage root (owner ${ownerId}, map ${mapId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
}

// Best-effort cleanup — callers use this after a rollback or a row delete, when
// a missing file is not an error. Sweeps every extension rather than the ones a
// ride is believed to have: a rollback happens precisely when the rows that
// would say which files exist are gone.
export async function deleteMapFiles(ownerId: number, mapId: number): Promise<void> {
  for (const ext of STORED_EXTS) {
    for (let i = 0; i < MAX_SOURCE_FILES; i++) {
      const path = mapFilePath(ownerId, mapId, ext, i)
      if (!path) continue
      await unlink(path).catch(() => {})
    }
  }
}

export { MAX_SOURCE_FILES }
