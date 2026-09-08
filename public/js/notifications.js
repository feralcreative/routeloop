// Raising Chrome's own notifications from an open page.
//
// **THIS IS THE Notification API AND NOT WEB PUSH, WHICH IS THE WHOLE SHAPE OF
// THE FEATURE.** Ziad's call, 2026-09-07. `new Notification(...)` is a call a
// LIVE DOCUMENT makes: no service worker, no VAPID key pair through the deploy
// allow-list and the compose block, no `web-push` dependency, and nothing to
// deploy. The price is the honest one and the settings page says it out loud —
// **nothing is raised while the site is closed.** A notification stored while
// the rider was away waits in the table and is raised the next time they open a
// tab, which is a nudge rather than a way to be reached.
//
// **THE SERVER STORES, THE PAGE RAISES, AND THE POLL IS WHAT JOINS THEM.** The
// server cannot call `new Notification` and the page cannot know what happened
// while it was shut, so the table is the hand-off. `POST /api/notifications/pending`
// CLAIMS what it returns — see that route on why it is a POST — so two open tabs
// cannot raise the same message twice, and this file never has to de-duplicate.
;(() => {
  'use strict'

  // Not every context has it: an insecure origin, an old browser, and some
  // embedded webviews all simply lack the constructor. Everything below is a
  // no-op then, which is correct — there is nothing to degrade to and nothing
  // to apologize for.
  const CAN = typeof window.Notification === 'function'

  // ONE MINUTE, AND THE VISIBILITY GATE IS WHAT MAKES THAT CHEAP. A tab left
  // open for a week would otherwise be 10,000 requests to be told nothing
  // happened; hidden tabs do not poll at all, and a tab coming back to the
  // foreground polls immediately rather than waiting out the rest of its
  // interval — which is the moment a rider is actually looking.
  const EVERY_MS = 60_000

  // Nothing is polled until the rider has actually granted permission. Before
  // that there is nothing to raise, and CLAIMING a notification we cannot show
  // would consume it — `delivered_at` is stamped by the read, so a poll made
  // while permission is 'default' would silently swallow the backlog.
  const granted = () => CAN && Notification.permission === 'granted'

  let timer = null
  let inFlight = false

  async function poll() {
    if (!granted() || inFlight || document.hidden) return
    inFlight = true
    try {
      const res = await fetch('/api/notifications/pending', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Same-origin cookies, and no body: the endpoint asks the session who
        // is calling and takes no arguments.
        credentials: 'same-origin',
      })
      if (!res.ok) return
      const data = await res.json()
      for (const n of data.notifications || []) raise(n)
    } catch {
      // A failed poll is a notification that arrives a minute later. There is
      // nothing to tell the rider and nothing to retry differently — the next
      // tick is the retry, and the row is still unclaimed because the claim and
      // the read are one statement.
    } finally {
      inFlight = false
    }
  }

  function raise(n) {
    try {
      const note = new Notification(n.title, {
        body: n.body,
        icon: '/img/favicon/web-app-manifest-192x192.png',
        // KEYED ON THE ROW ID, so a notification cannot be shown twice by two
        // windows of the same browser — Chrome replaces a notification carrying
        // a tag it already has rather than stacking a duplicate. The claim on
        // the server covers separate SESSIONS; this covers one browser's
        // windows, which share a permission and not a poll.
        tag: `routeloop-${n.id}`,
      })
      if (n.url) {
        note.onclick = () => {
          // FOCUS BEFORE NAVIGATING. A click on a notification does not raise
          // the window on its own, so navigating first leaves the rider looking
          // at whatever they were doing while the ride they asked for loads
          // behind it.
          window.focus()
          window.location.href = n.url
          note.close()
        }
      }
    } catch {
      // Some platforms refuse the constructor even with permission granted —
      // notably a page whose OS has Do Not Disturb on. Losing the toast is the
      // whole cost; the row is already claimed and the email, if they wanted
      // one, has already gone.
    }
  }

  function start() {
    if (timer || !granted()) return
    poll()
    timer = setInterval(poll, EVERY_MS)
  }

  // The permission control on /settings. It is a real button and the ask is
  // BEHIND it deliberately: a permission prompt fired on page load is the single
  // most-refused dialog on the web, and a refusal is close to permanent — Chrome
  // remembers it, and the rider has to go into site settings to undo it. Asking
  // only when somebody has said they want this is what keeps the answer
  // recoverable.
  function wirePermissionUi() {
    const box = document.querySelector('[data-notif-permission]')
    if (!box) return
    const state = box.querySelector('[data-notif-state]')
    const ask = box.querySelector('[data-notif-ask]')
    if (!CAN) {
      // Shown rather than hidden, and saying why: a rider who has ticked the
      // browser column and sees nothing happen deserves to know it is their
      // browser rather than their setting.
      box.hidden = false
      if (ask) ask.hidden = true
      if (state) state.textContent = 'This browser cannot show notifications.'
      return
    }
    box.hidden = false

    const paint = () => {
      const p = Notification.permission
      if (ask) ask.hidden = p !== 'default'
      if (!state) return
      state.textContent =
        p === 'granted'
          ? 'Allowed. Anything ticked in the browser column will appear while Routeloop is open.'
          : p === 'denied'
            ? 'Blocked by your browser. Allow notifications for this site in your browser’s settings to turn it back on.'
            : 'Not asked yet. Nothing appears in the browser until you allow it.'
      state.dataset.state = p
    }

    if (ask) {
      ask.addEventListener('click', async () => {
        try {
          await Notification.requestPermission()
        } catch {
          // Older Safari resolves this through a callback rather than a promise
          // and can throw here. Repainting is still right — the permission may
          // have changed regardless of how the answer came back.
        }
        paint()
        start()
      })
    }
    paint()
  }

  document.addEventListener('visibilitychange', () => {
    // Coming back to the foreground is exactly when a rider is looking, so the
    // backlog is raised now rather than up to a minute later.
    if (!document.hidden) poll()
  })

  wirePermissionUi()
  start()
})()
