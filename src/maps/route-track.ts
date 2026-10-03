// A ride's routes as PostGIS lines (#37), rebuilt from route_legs. The migration
// that created route_tracks backfilled it with this same statement; every writer
// of legs calls this after its inserts so the two cannot drift. Delete-then-insert
// because a save reinserts every route, and routes cascade to their tracks anyway.
import { sql } from 'drizzle-orm'
import type { Tx } from './ride-graph'

export async function refreshRouteTracks(tx: Tx, rideId: number): Promise<void> {
  await tx.execute(sql`delete from route_tracks where ride_id = ${rideId}`)
  await tx.execute(sql`
    insert into route_tracks (route_id, ride_id, track)
    select r.id, r.ride_id,
           ST_SetSRID(ST_MakeLine(ST_MakePoint((v.c->>0)::float8, (v.c->>1)::float8) order by l.position, v.ord), 4326)
    from routes r
    join route_legs l on l.route_id = r.id
    cross join lateral jsonb_array_elements(l.geometry) with ordinality as v(c, ord)
    where r.ride_id = ${rideId}
    group by r.id, r.ride_id
    having count(*) >= 2`)
}
