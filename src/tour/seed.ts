// The ride the tour starts from: keyframe zero.
//
// One route, one stop, no legs — the smallest ride `ridePayload` accepts, and
// what POST /api/tour/start inserts. The uids are FIXED rather than minted so
// the fixture's later keyframes can carry the same ones forward: a route or a
// point whose uid changes between frames reads to the day-merge as deleted and
// re-added, which churns its base hash and is how a frame comes back
// `adopted`. utils/build-tour-fixture.ts imports these and nothing else here.
//
// The point is Jack London Square, which is where the demo ride sets off from
// whoever is watching — the tour never seeds the rider's home base, because the
// story is the same every time and a home base would put the first pin
// somewhere the fixture's roads do not go.
import { ridePayload, type RidePayload } from '../maps/ride-graph'

export const TOUR_SEED = {
  title: 'Untitled ride',
  routeUid: 'tourroute001',
  pointUid: 'tourpoint001',
  // The main group, seeded here with a fixed uid for the reason the route's
  // is: the fixture's later frames name it, and a group whose uid changed
  // would be reconciled away and re-inserted, which drops every rider
  // assignment on it.
  group: { uid: 'toursgmain01', name: 'Group 1', color: '#0066cc' },
  start: { lng: -122.279, lat: 37.7955, name: 'Oakland', address: 'Jack London Square, Oakland, CA' },
} as const

/** How the tour's ride is titled while it is being built. What the rider
 *  types on the first card replaces it, and what the fixture calls it after. */
export const TOUR_RIDE_TITLE = 'Coast run'

export function seedPayload(): RidePayload {
  // Parsed rather than cast, so the seed is refused here on the day the
  // schema grows a required field instead of at the insert.
  return ridePayload.parse({
    title: TOUR_SEED.title,
    description: '',
    visibility: 'private',
    external_url: '',
    subgroups: [{ ...TOUR_SEED.group }],
    primarySubgroup: TOUR_SEED.group.uid,
    trunkSubgroup: null,
    stopByMin: null,
    timeAnchor: 'departure',
    routes: [
      {
        uid: TOUR_SEED.routeUid,
        subgroupUid: null,
        title: '',
        color: '#0066cc',
        startAt: null,
        endAt: null,
        altGroup: null,
        altActive: true,
        routePrefs: null,
        points: [
          {
            kind: 'stop',
            lng: TOUR_SEED.start.lng,
            lat: TOUR_SEED.start.lat,
            name: TOUR_SEED.start.name,
            address: TOUR_SEED.start.address,
            description: '',
            roles: ['start'],
            durationMin: null,
            slackMin: null,
            uid: TOUR_SEED.pointUid,
            details: null,
          },
        ],
        legs: [],
      },
    ],
  })
}
