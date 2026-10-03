// Clubs (#182): the pure half. service.ts is the only module that touches the
// club tables.
//
// TWO AXES AND THEY DO NOT OVERLAP. Who is in the club is the manager's call
// alone: admitting, adding, removing, and setting a member's position. What the
// club says (name, chapters, icon) is every member's: flat, with no founder or
// officer tier. The manager's remedy for a member who edits badly is removal,
// which is what makes flat editing safe.
//
// A POSITION IS A TITLE, NOT A PERMISSION. The president is not the manager
// unless the admin made them so; nothing here may infer one from the other.
//
// AN OWNERLESS CLUB IS A DEFINED STATE: when the manager's account goes, the
// club keeps its members, who may still edit it and leave, and nobody can join
// until an admin appoints a new manager.
import type { ClubPosition } from '../db/schema'

export const POSITIONS: readonly ClubPosition[] = [
  'member',
  'president',
  'vice_president',
  'secretary',
  'treasurer',
  'road_captain',
  'sergeant_at_arms',
]

export const POSITION_LABEL: Record<ClubPosition, string> = {
  member: 'Member',
  president: 'President',
  vice_president: 'Vice president',
  secretary: 'Secretary',
  treasurer: 'Treasurer',
  road_captain: 'Road captain',
  sergeant_at_arms: 'Sergeant at arms',
}

export const isPosition = (v: unknown): v is ClubPosition =>
  typeof v === 'string' && (POSITIONS as readonly string[]).includes(v)

export const MAX_CLUB_NAME = 80
export const MAX_CHAPTER_NAME = 60

export type Standing = 'none' | 'requested' | 'member'

type Club = { managerId: number | null }

export const isManager = (club: Club, userId: number): boolean => club.managerId != null && club.managerId === userId

/** Any member edits the name, chapters and icon. The manager is always a member. */
export const canEdit = (club: Club, userId: number, standing: Standing): boolean =>
  standing === 'member' || isManager(club, userId)

/** Admitting, adding, removing and titling members: the manager and nobody else. */
export const canManageRoster = (club: Club, userId: number): boolean => isManager(club, userId)

/** A rider may ask to join a club that has a manager to answer, and that they
 *  are not already in or waiting on. An ownerless club admits nobody. */
export const canRequest = (club: Club, userId: number, standing: Standing): boolean =>
  club.managerId != null && standing === 'none' && !isManager(club, userId)

/** Leaving is always the rider's own: a member walks out, a request is withdrawn.
 *  The manager cannot leave their own roster; the torch passes through an admin. */
export const canLeave = (club: Club, userId: number, standing: Standing): boolean =>
  standing !== 'none' && !isManager(club, userId)

/** A manager may remove anyone but themselves. */
export const canRemove = (club: Club, actorId: number, targetId: number): boolean =>
  canManageRoster(club, actorId) && actorId !== targetId

export function cleanName(v: unknown, max: number): string | null {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
  return s.length ? s : null
}
