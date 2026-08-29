// Downloads, source-aware.
//
// An imported ride streams its stored original for the format it arrived in —
// byte-for-byte what the rider uploaded, which is the entire reason the file is
// kept. Every other format, and every format of a native ride, is generated
// from the rows. So a KML import can be downloaded as GPX and a ride built here
// can be downloaded as either, neither of which was possible before.
//
// One table rather than four handlers: the visibility gate, the nosniff header
// and the attachment naming are identical for all of them, and four copies of
// that is four places for one of them to drift.
//
// It lives here rather than beside the routes that first used it because the
// account export needs the same four formats for every ride a rider owns, and
// importing it back out of the app entry point would be a cycle.
import type { RideRow } from '../db/schema'
import { buildCsv, buildGeoJson, buildGpx, buildKml, type ExportRide } from './export'
import type { StoredExt } from './storage'

export type DownloadSpec = {
  type: string
  stored: StoredExt
  hasStored: (m: RideRow) => boolean
  // firstDay is only passed by the per-day zip, where each file holds one
  // day that is day N of a ride rather than day 1 of itself.
  build: (r: ExportRide, firstDay?: number) => string
}

/**
 * Does the stored original still describe this ride?
 *
 * **THE FILE ON DISK IS NOT UPDATED BY A SAVE, AND NOTHING CLEARS IT.** That was
 * harmless while the original always won and nearly nobody reached it — the only
 * way was typing the download URL — and it stopped being harmless when #172 put
 * an Export control in the builder. A rider who imported a GPX, spent an hour
 * re-cutting it and pressed Export got their hour back as the pre-edit file,
 * silently and with nothing raised.
 *
 * So the original wins only while it is still TRUE. `original_stored_at` is
 * stamped in the same transaction that writes the file, so a ride whose
 * `updated_at` has moved past it has been rebuilt here and its rows are the
 * better answer. Same shape as `updated_at > thumb_built_at`, deliberately.
 *
 * **NULL IS "STILL CURRENT", NOT "STALE".** It means nothing recorded the write,
 * which after the 0023 backfill is only true of a ride with no stored original
 * at all — and every caller checks `hasStored` first. Reading null as stale
 * would silently start generating for any row the backfill missed, which is the
 * lossy answer given for free to exactly the rides nobody looked at.
 *
 * Nothing is deleted either way: the file stays on disk, still counted in the
 * rider's quota, and the account archive still hands back what they uploaded.
 * This decides which of two true things a download answers with.
 */
export function originalIsCurrent(m: Pick<RideRow, 'originalStoredAt' | 'updatedAt'>): boolean {
  if (!m.originalStoredAt) return true
  return m.updatedAt.getTime() <= m.originalStoredAt.getTime()
}

export const DOWNLOADS: Record<string, DownloadSpec> = {
  kml: {
    type: 'application/vnd.google-earth.kml+xml',
    stored: 'kml',
    // A KMZ is stored as the KML from inside it, so it answers here too. Rows
    // predating source_format have it backfilled from whichever file they kept.
    hasStored: (m) => m.kmlBytes > 0 && (m.sourceFormat === 'kml' || m.sourceFormat === 'kmz'),
    build: buildKml,
  },
  gpx: {
    type: 'application/gpx+xml',
    stored: 'gpx',
    hasStored: (m) => m.gpxPresent && m.sourceFormat === 'gpx',
    build: buildGpx,
  },
  // These two have no byte column of their own; source_format is what says the
  // ride arrived as one, and source_bytes that the file is on disk.
  geojson: {
    type: 'application/geo+json',
    stored: 'geojson',
    hasStored: (m) => m.sourceBytes > 0 && (m.sourceFormat === 'geojson' || m.sourceFormat === 'json'),
    build: buildGeoJson,
  },
  csv: {
    type: 'text/csv',
    stored: 'csv',
    hasStored: (m) => m.sourceBytes > 0 && m.sourceFormat === 'csv',
    build: buildCsv,
  },
}

// Every branch above tests source_format, which is what keeps a folder import
// from streaming one of its files as if it were the whole ride: several files
// store 'mixed', which matches nothing, so those rides always generate from the
// rows — and the rows are the merged ride, which is the correct answer.

/** The four generated formats, in the order a rider sees them everywhere else. */
export const DOWNLOAD_FORMATS = ['gpx', 'kml', 'geojson', 'csv'] as const
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number]

/**
 * Which extension a stored original is actually filed under.
 *
 * A .json upload is stored under .json, not .geojson — the extension is the one
 * the rider sent. Both are the same format and both answer /geojson.
 */
export function storedExtFor(spec: DownloadSpec, m: RideRow): StoredExt {
  return spec.stored === 'geojson' && m.sourceFormat === 'json' ? 'json' : spec.stored
}
