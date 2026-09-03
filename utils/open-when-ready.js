// Opens the app in a browser once `npm start` is serving.
//
// This lives OUTSIDE the server on purpose. `npm start` runs the server under
// `tsx watch`, which restarts the process on every file save — an opener inside
// `src/index.tsx` would spawn a new tab each time. Run it once per `npm start`
// instead, alongside the server, and exit as soon as the port answers.
//
// Set OPEN_BROWSER=0, or use `npm run start:no-open`, to skip it.

import { spawn } from 'node:child_process'

// PORT lives in `.env` and is read by dotenv inside the app, so the shell that
// runs this script has no idea what it is. `process.loadEnvFile()` reads the
// same file without pulling dotenv in; an absent `.env` is fine, because 6686
// is the port this project owns and `src/config.ts` defaults to it too.
try {
  process.loadEnvFile()
} catch {}

const PORT = Number(process.env.PORT) || 6686
const URL = `http://localhost:${PORT}/`
// Generous, because `predev` runs the migrations before the server starts.
const TIMEOUT_MS = 60_000
const POLL_MS = 250

if (process.env.OPEN_BROWSER === '0') process.exit(0)

const opener =
  process.platform === 'darwin'
    ? ['open', [URL]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', URL]]
      : ['xdg-open', [URL]]

// ANY HTTP response means the server is listening — a 503 from a draining
// container or a redirect counts exactly as much as a 200.
async function isUp() {
  try {
    await fetch(`http://localhost:${PORT}/healthz`, { signal: AbortSignal.timeout(POLL_MS * 2) })
    return true
  } catch {
    return false
  }
}

const deadline = Date.now() + TIMEOUT_MS
while (Date.now() < deadline) {
  if (await isUp()) {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref()
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, POLL_MS))
}

console.warn(`[open] Server did not answer within ${TIMEOUT_MS / 1000}s; open ${URL} yourself.`)
