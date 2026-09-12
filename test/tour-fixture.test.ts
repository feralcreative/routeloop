// The guided tour's fixture, public/tour/coast-run.json.
//
// Every keyframe is applied to the real builder and saved through the real
// PUT, so a frame that does not parse as a ride payload is a tour that dies
// on that card. The uid rule is the other half: the server merges per route
// by uid, so a uid that changed between frames reads as a delete plus an add
// and the frame comes back `adopted`. Both are pinned here, against the file
// as committed, because the builder script runs on a dev machine and nothing
// else would notice it drifting from the seed the endpoint inserts.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { GUIDES } from '../src/tour/guides'
import { seedPayload, TOUR_SEED } from '../src/tour/seed'

type Fixture = {
  version: number
  t0: string
  title: string
  keyframes: Array<{ id: string; ride: RidePayload }>
  legs: Record<string, { geometry: [number, number][]; distanceM: number; durationS: number }>
  meet: { groups: Array<{ group: string; candidates: Array<{ lng: number; lat: number; approach: number[][] }> }> }
  members: Array<{ guide: string; group: string }>
  split: {
    at: { routeUid: string; pointUid: string }
    peel: { routeUid: string; riders: Array<{ guide: string; group: string }> }
    onward: { routeUid: string; riders: Array<{ guide?: string; owner?: boolean }> }
  }
}

const raw = JSON.parse(readFileSync('public/tour/coast-run.json', 'utf8')) as Fixture

// The same five lines tour.js runs before applying a frame.
function inflate(fx: Fixture, ride: RidePayload): RidePayload {
  return {
    ...ride,
    routes: ride.routes.map((r) => ({
      ...r,
      legs: r.legs.map((l) => {
        const ref = (l as unknown as { ref: string }).ref
        return { ...fx.legs[ref], viaPoints: l.viaPoints ?? [] }
      }),
    })),
  }
}

const frames = raw.keyframes.map((f) => ({ id: f.id, ride: inflate(raw, f.ride) }))
const ORDER = ['named', 'point2', 'point3', 'point4', 'via', 'category', 'dwell', 'start', 'bed', 'group', 'gas', 'meet', 'split']

describe('the tour fixture', () => {
  it('is the thirteen frames of the story, in order', () => {
    expect(frames.map((f) => f.id)).toEqual(ORDER)
    expect(raw.version).toBe(1)
  })

  it('has every frame parse as a ride payload', () => {
    for (const f of frames) {
      const r = ridePayload.safeParse(f.ride)
      expect(r.success, `${f.id}: ${JSON.stringify(r.success ? '' : r.error.issues[0])}`).toBe(true)
    }
  })

  it('starts from the seed the endpoint inserts', () => {
    const seed = seedPayload()
    const first = frames[0].ride
    expect(first.routes[0].uid).toBe(seed.routes[0].uid)
    expect(first.routes[0].points[0].uid).toBe(seed.routes[0].points[0].uid)
    expect(first.subgroups[0].uid).toBe(TOUR_SEED.group.uid)
    expect(first.primarySubgroup).toBe(TOUR_SEED.group.uid)
    expect(first.title).toBe(raw.title)
  })

  it('never churns a uid: routes, points and groups only accumulate', () => {
    let routes = new Set<string>()
    let points = new Set<string>()
    let groups = new Set<string>()
    for (const f of frames) {
      const r = new Set(f.ride.routes.map((x) => x.uid!))
      const p = new Set(f.ride.routes.flatMap((x) => x.points.map((pt) => pt.uid!)))
      const g = new Set(f.ride.subgroups.map((x) => x.uid))
      for (const u of routes) expect(r.has(u), `${f.id} dropped route ${u}`).toBe(true)
      for (const u of points) expect(p.has(u), `${f.id} dropped point ${u}`).toBe(true)
      for (const u of groups) expect(g.has(u), `${f.id} dropped group ${u}`).toBe(true)
      // And no uid is used twice within one frame.
      expect(p.size).toBe(f.ride.routes.flatMap((x) => x.points).length)
      routes = r
      points = p
      groups = g
    }
  })

  it('keeps every time within a day of the anchor, so one shift moves the whole ride', () => {
    const t0 = Date.parse(raw.t0)
    expect(Number.isFinite(t0)).toBe(true)
    for (const f of frames) {
      for (const r of f.ride.routes) {
        if (r.startAt == null) continue
        const t = Date.parse(r.startAt)
        expect(Math.abs(t - t0)).toBeLessThan(24 * 3600 * 1000)
      }
    }
  })

  it('names guides that exist and routes and groups the last frame holds', () => {
    const last = frames[frames.length - 1].ride
    const routes = new Set(last.routes.map((r) => r.uid))
    const groups = new Set(last.subgroups.map((g) => g.uid))
    const handles = new Set(GUIDES.map((g) => g.username))
    for (const m of raw.members) {
      expect(handles.has(m.guide)).toBe(true)
      expect(groups.has(m.group)).toBe(true)
    }
    expect(routes.has(raw.split.peel.routeUid)).toBe(true)
    expect(routes.has(raw.split.onward.routeUid)).toBe(true)
    expect(routes.has(raw.split.at.routeUid)).toBe(true)
    for (const r of raw.split.peel.riders) {
      expect(handles.has(r.guide)).toBe(true)
      expect(groups.has(r.group)).toBe(true)
    }
    expect(raw.split.onward.riders.some((r) => r.owner)).toBe(true)
    for (const g of raw.meet.groups) expect(groups.has(g.group)).toBe(true)
    // The meeting point taken is the first candidate, and it is on the ride.
    const c = raw.meet.groups[0].candidates[0]
    const meetFrame = frames.find((f) => f.id === 'meet')!.ride
    const at = meetFrame.routes.flatMap((r) => r.points).filter((p) => p.lng === c.lng && p.lat === c.lat)
    expect(at.length).toBeGreaterThan(0)
  })

  it('has a short tank to show and a gas stop that fixes it', () => {
    const binding = Math.min(...GUIDES.map((g) => g.bike.rangeMi))
    const gasFrame = frames.find((f) => f.id === 'gas')!.ride
    const main = gasFrame.routes[0]
    const miles = main.legs.reduce((n, l) => n + l.distanceM, 0) / 1609.344
    // Dry before the end on one tank…
    expect(miles).toBeGreaterThan(binding)
    // …and the fill at Pescadero is the fix.
    const gasAt = main.points.findIndex((p) => p.roles.includes('gas'))
    expect(gasAt).toBeGreaterThan(0)
    const toGas = main.legs.slice(0, gasAt).reduce((n, l) => n + l.distanceM, 0) / 1609.344
    expect(toGas).toBeLessThan(binding)
    expect(toGas + binding).toBeGreaterThan(miles)
  })
})
