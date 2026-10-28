// Counts what one agent turn spends on Google, against both the turn's own ceilings
// and what is left of the rider's day. PURE: usage.ts reads the day's count before
// the turn and writes the total after it.
import { DAILY_GOOGLE_CALLS, TURN_LIMITS } from './policy'

export type Spend = 'search' | 'leg'

export class Budget {
  searches = 0
  legs = 0
  constructor(private readonly usedToday: number) {}

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
      if (this.searches >= TURN_LIMITS.placeSearches) return false
      this.searches++
      return true
    }
    if (this.legs >= TURN_LIMITS.legRoutings) return false
    this.legs++
    return true
  }
}
