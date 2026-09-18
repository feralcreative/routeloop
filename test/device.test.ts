// "Is this a phone?" — the one User-Agent decision in the app, and the reason
// it is pinned: a desktop wrongly called a phone loses the dashboard from its
// own address, where a phone this misses merely has /rides one tap away.
import { describe, expect, it } from 'vitest'
import { isPhone } from '../src/device'

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()]

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0'

describe('isPhone', () => {
  it('believes the client hint when a browser sends one', () => {
    expect(isPhone(headers({ 'sec-ch-ua-mobile': '?1', 'user-agent': MAC_CHROME }))).toBe(true)
    expect(isPhone(headers({ 'sec-ch-ua-mobile': '?0', 'user-agent': IPHONE }))).toBe(false)
  })

  it('reads the User-Agent when there is no hint, which is every Safari', () => {
    expect(isPhone(headers({ 'user-agent': IPHONE }))).toBe(true)
    expect(isPhone(headers({ 'user-agent': ANDROID_PHONE }))).toBe(true)
  })

  it('calls a tablet a desktop, on both platforms', () => {
    expect(isPhone(headers({ 'user-agent': IPAD_DESKTOP }))).toBe(false)
    expect(isPhone(headers({ 'user-agent': ANDROID_TABLET }))).toBe(false)
  })

  it('calls a desktop a desktop', () => {
    expect(isPhone(headers({ 'user-agent': MAC_CHROME }))).toBe(false)
    expect(isPhone(headers({ 'user-agent': WINDOWS_FIREFOX }))).toBe(false)
  })

  it('answers no to nothing at all', () => {
    expect(isPhone(headers({}))).toBe(false)
    expect(isPhone(() => null)).toBe(false)
  })
})
