// Counts what one agent turn spends on Google, against both the turn's own ceilings
// and what is left of the rider's day. PURE: usage.ts reads the day's count before
// the turn and writes the total after it.
import { DAILY_GOOGLE_CALLS, TURN_LIMITS } from './policy'

export type Spend = 'search' | 'leg'

export class Budget {
  searches = 0
  legs = 0
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

  /** Claims one call if both the turn and the day allow it. */
  take(kind: Spend): boolean {
    if (this.dayExhausted) return false
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
  }
}
