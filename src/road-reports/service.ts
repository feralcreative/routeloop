// Road reports (#48, #53): the only module that reads or writes road_reports.
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index'
import { roadReports, type RoadReportRow } from '../db/schema'
import { REPORT_RADIUS_M, expiresAtFor, type ReportInput, type ReportKind } from './policy'

export type ReportView = {
  id: number
  kind: ReportKind
  note: string
  at: [number, number]
  season: { start: number; end: number } | null
  createdAt: string
  expiresAt: string | null
  mine: boolean
  /** The route uids this report sits on. */
  routes: string[]
}

export async function createReport(reporterId: number, input: ReportInput, now = new Date()): Promise<number> {
  const [row] = await db
    .insert(roadReports)
    .values({
      reporterId,
      kind: input.kind,
      note: input.note,
      at: input.at,
      seasonStart: input.season?.start ?? null,
      seasonEnd: input.season?.end ?? null,
      expiresAt: expiresAtFor(input.kind, input.season != null, now),
    })
    .returning({ id: roadReports.id })
  return row.id
}

export async function findReport(id: number): Promise<RoadReportRow | null> {
  const [row] = await db.select().from(roadReports).where(eq(roadReports.id, id)).limit(1)
  return row ?? null
}

export async function deleteReport(id: number): Promise<void> {
  await db.delete(roadReports).where(eq(roadReports.id, id))
}

/**
 * Every live report within REPORT_RADIUS_M of any route of a ride, with the routes it
 * sits on. Read against route_tracks, so a route saved by an old release during a
 * cutover, which has no track yet, simply contributes nothing until its next save.
 * Geography casts make the radius meters rather than degrees.
 */
export async function reportsAlongRide(rideId: number, viewerId: number | null, now = new Date()): Promise<ReportView[]> {
  const rows = await db.execute<{
    id: string
    reporter_id: string
    kind: ReportKind
    note: string
    lng: number
    lat: number
    season_start: number | null
    season_end: number | null
    created_at: string | Date
    expires_at: string | Date | null
    route_uids: string[]
  }>(sql`
    select rr.id, rr.reporter_id, rr.kind, rr.note, ST_X(rr.at) as lng, ST_Y(rr.at) as lat,
           rr.season_start, rr.season_end, rr.created_at, rr.expires_at,
           array_agg(distinct r.uid) as route_uids
    from road_reports rr
    join route_tracks t on ST_DWithin(rr.at::geography, t.track::geography, ${REPORT_RADIUS_M})
    join routes r on r.id = t.route_id
    where t.ride_id = ${rideId} and (rr.expires_at is null or rr.expires_at > ${now.toISOString()})
    group by rr.id
    order by rr.created_at desc`)
  return rows.rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    note: r.note,
    at: [Number(r.lng), Number(r.lat)],
    season: r.season_start != null && r.season_end != null ? { start: r.season_start, end: r.season_end } : null,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    mine: viewerId != null && Number(r.reporter_id) === viewerId,
    routes: r.route_uids,
  }))
}

