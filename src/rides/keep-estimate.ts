// ROUGHLY HOW MANY BYTES A KEPT RIDE PUTS ON A PHONE, so the "On this phone"
// switch can say what a download will cost before it starts. A rider on a
// metered connection on the road is who asks. Measured on dev 2026-10-04: a
// 13-route ride of 63,765 track points kept a 2.99 MB GPX (about 47 bytes a
// point), a 179 KB go page and a 65 KB roadbook (about 19 KB a route between
// the two). The GPX dominates, so the point count is what the estimate rides
// on. It is the size AT REST, which is what the registry row's `bytes` counts;
// over the wire the GPX is compressed, so the prompt says "up to".
export const BYTES_PER_POINT = 47
export const BYTES_PER_ROUTE = 20_000
export const BYTES_BASE = 20_000

export function keepEstimateBytes(points: number, routes: number): number {
  const p = Number.isFinite(points) && points > 0 ? points : 0
  const r = Number.isFinite(routes) && routes > 0 ? routes : 0
  return BYTES_BASE + p * BYTES_PER_POINT + r * BYTES_PER_ROUTE
}
