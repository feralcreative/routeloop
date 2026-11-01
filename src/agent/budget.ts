// Counts what one agent turn spends on Google, against both the turn's own ceilings
// and what is left of the rider's day. PURE: usage.ts reads the day's count before
// the turn and writes the total after it.
import { DAILY_GOOGLE_CALLS, TURN_LIMITS } from './policy'

export type Spend = 'search' | 'leg'

export class Budget {
  searches = 0
  legs = 0
  /** This tool call's own ceiling and what it has used, set by beginCall(). Null
   *  before the first call, which leaves direct callers (tests) unbounded by it. */
  private call: { search: number; leg: number; usedSearch: number; usedLeg: number } | null = null
  /**
   * `perTurn: false` is the MCP server's mode: a remote client has no turn, each
   * tool call is its own request, so only the rider's day (plus that endpoint's
   * request rate limit) bounds it.
   */
  constructor(
    private readonly usedToday: number,
    private readonly opts: { perTurn: boolean } = { perTurn: true },
  ) {}

  get googleCalls(): number {
    return this.searches + this.legs
  }

  get dayExhausted(): boolean {
    return this.usedToday + this.googleCalls >= DAILY_GOOGLE_CALLS
  }

  /** Starts one tool call with the ceiling its capability declares. A tool that
   *  declared nothing may spend nothing. */
  beginCall(spends: { search?: number; leg?: number } | undefined): void {
    this.call = { search: spends?.search ?? 0, leg: spends?.leg ?? 0, usedSearch: 0, usedLeg: 0 }
  }

  /** Claims one call if the tool call, the turn, and the day all allow it. */
  take(kind: Spend): boolean {
    if (this.dayExhausted) return false
    if (this.call) {
      if (kind === 'search' && this.call.usedSearch >= this.call.search) return false
      if (kind === 'leg' && this.call.usedLeg >= this.call.leg) return false
    }
    const ok = this.takeTurn(kind)
    if (ok && this.call) {
      if (kind === 'search') this.call.usedSearch++
      else this.call.usedLeg++
    }
    return ok
  }

  private takeTurn(kind: Spend): boolean {
    if (kind === 'search') {
      if (this.opts.perTurn && this.searches >= TURN_LIMITS.placeSearches) return false
      this.searches++
      return true
    }
    if (this.opts.perTurn && this.legs >= TURN_LIMITS.legRoutings) return false
    this.legs++
    return true
  }

  /** Gives a claimed call back when the answer came from the cache and Google was
   *  never asked, so the budget counts what is actually billed. */
  refund(kind: Spend): void {
    if (kind === 'search' && this.searches > 0) this.searches--
    if (kind === 'leg' && this.legs > 0) this.legs--
    if (this.call) {
      if (kind === 'search' && this.call.usedSearch > 0) this.call.usedSearch--
      if (kind === 'leg' && this.call.usedLeg > 0) this.call.usedLeg--
    }
  }
}
