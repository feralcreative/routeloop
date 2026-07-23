// User-file storage, outside the web root. Paths are built only from integer
// ids ({STORAGE}/{ownerId}/{mapId}.{ext}) and containment-checked against the
// root — path traversal is structurally impossible, the check is belt and
// braces.
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const STORAGE = resolve(process.env.STORAGE_PATH ?? './moto-storage')

// Returns the absolute path for a map file, or undefined if it would somehow
// escape the storage root.
export function mapFilePath(ownerId: number, mapId: number, ext: 'kml' | 'gpx'): string | undefined {
  const path = resolve(STORAGE, String(ownerId), `${mapId}.${ext}`)
  if (path !== STORAGE && !path.startsWith(STORAGE + sep)) return undefined
  return path
}

// 0640: readable by the app and its group, nobody else.
export async function writeMapFile(ownerId: number, mapId: number, ext: 'kml' | 'gpx', data: string | Buffer): Promise<void> {
  const path = mapFilePath(ownerId, mapId, ext)
  if (!path) throw new Error(`refusing to write outside storage root (owner ${ownerId}, map ${mapId})`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { mode: 0o640 })
}

// Best-effort cleanup — callers use this after a rollback or a row delete, when
// a missing file is not an error.
export async function deleteMapFiles(ownerId: number, mapId: number): Promise<void> {
  for (const ext of ['kml', 'gpx'] as const) {
    const path = mapFilePath(ownerId, mapId, ext)
    if (!path) continue
    await unlink(path).catch(() => {})
  }
}
