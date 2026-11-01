// What the assistant knows about the group's tank, resolved once per turn or call
// by the surface (src/routes/agent.ts, src/mcp/server.ts) and read by get_fuel_plan,
// get_rider_context and check_ride.
//
// THE SAME ANSWERS THE MAP USES: the binding range is groupRange() over the planning
// roster, the builder's own source, and the fuel role is fuelRoleOf(), so a pedal ride
// has none. NO RIDER IS NAMED: groupRange() knows whose bike binds, and only the
// bike's label leaves this file (src/agent/privacy.ts).
import { groupRange, ownRange } from '../bikes/group-range'
import { fuelRoleOf, type FuelRole } from '../subgroups/rendezvous'
import { METERS_PER_MILE } from '../maps/kml'

export type FuelContext = {
  /** The shortest usable range on the ride, in meters, or null when nobody's is on file. */
  rangeM: number | null
  /** What refuels: gas, charge, or null on a pedal ride. */
  role: FuelRole | null
  /** The binding bike's label, never its rider. */
  bindingBike: string | null
  /** Riders coming, and how many of them have no range on file. */
  riders: number
  unknown: number
}

export async function fuelContextFor(
  rideId: number | undefined,
  userId: number,
  ride: { power: string | null; vehicle: string | null },
  profile: { power?: string | null; vehicle?: string | null } | null,
  standing: 'view' | 'edit' | 'owner',
): Promise<FuelContext> {
  // THE PLANNING ROSTER ONLY FOR SOMEBODY WHO PLANS. It counts drafts and riders not
  // yet invited, which a view-level rider is not shown anywhere else, so they get the
  // live members' range, the one the ride page shows them.
  const range = rideId ? await groupRange(rideId, { planning: standing !== 'view' }) : await ownRange(userId)
  const role = fuelRoleOf({
    ridePower: ride.power,
    rideVehicle: ride.vehicle,
    bikeFuel: range.fuelType,
    profilePower: profile?.power ?? null,
    profileVehicle: profile?.vehicle ?? null,
  })
  return {
    rangeM: range.miles != null ? range.miles * METERS_PER_MILE : null,
    role,
    bindingBike: range.bikeLabel,
    riders: range.riders,
    unknown: range.unknown,
  }
}
