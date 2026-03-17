/**
 * Web Terminal PTY Server
 *
 * WebSocket server that spawns Gemini CLI (or fallback shell) as a PTY process
 * and bridges stdin/stdout over WebSocket, allowing trainers to use Gemini CLI
 * through a web browser.
 *
 * Protocol:
 *   Client -> Server:
 *     {type: "auth",   token: "..."}
 *     {type: "input",  data: "..."}
 *     {type: "resize", cols: N, rows: N}
 *
 *   Server -> Client:
 *     {type: "auth_success"}
 *     {type: "auth_failed"}
 *     {type: "output", data: "..."}
 *     {type: "error",  message: "..."}
 */

const WebSocket = require('ws')
const path = require('path')
const { execSync } = require('child_process')

// ── Constants ────────────────────────────────────────────────
const MAX_SESSIONS = 3
const HEARTBEAT_INTERVAL_MS = 30_000
const AUTH_TIMEOUT_MS = 10_000
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const IS_WINDOWS = process.platform === 'win32'

// ── Helpers ──────────────────────────────────────────────────

/**
 * Try to load node-pty. It is a native module that must be installed separately.
 * Returns null if unavailable so the caller can surface a clear error.
 */
function loadNodePty() {
  try {
    return require('node-pty')
  } catch {
    return null
  }
}

/**
 * Detect whether the `gemini` CLI is available on the system PATH.
 */
function isGeminiAvailable() {
  try {
    const cmd = IS_WINDOWS ? 'where gemini' : 'which gemini'
    // Include user-local bin dirs in PATH for detection
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const extraPath = IS_WINDOWS ? '' : [
      homeDir + '/node22/bin',
      homeDir + '/.npm-global/bin',
      homeDir + '/.local/bin',
    ].join(':') + ':'
    const env = Object.assign({}, process.env, {
      PATH: extraPath + (process.env.PATH || ''),
    })
    execSync(cmd, { stdio: 'ignore', env })
    return true
  } catch {
    return false
  }
}

/**
 * Safe JSON send – only sends when the socket is open.
 */
function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    // swallow – socket may have closed between the check and the send
  }
}

// ── Main export ──────────────────────────────────────────────

/**
 * Attach the terminal WebSocket endpoint to an existing HTTP server.
 *
 * @param {import('http').Server} server – the HTTP server instance
 */
function initTerminalWebSocket(server) {
  const pty = loadNodePty()
  if (!pty) {
    console.warn(
      '[Terminal] node-pty is not installed. Run `npm install node-pty` to enable the web terminal.'
    )
  }

  const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: false,
  })

  // Track active sessions for the concurrency limit
  const activeSessions = new Set()

  // ── Upgrade handling (path-based routing) ──────────────────
  server.on('upgrade', (req, socket, head) => {
    // Only handle our path; let other upgrade handlers (e.g. /ws/chat) pass through
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname !== '/ws/terminal') return

    // Check node-pty availability before accepting
    if (!pty) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    // Enforce max concurrent sessions
    if (activeSessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  // ── Heartbeat / ping ───────────────────────────────────────
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws._termAlive === false) {
        // Did not respond to last ping – terminate
        ws.terminate()
        return
      }
      ws._termAlive = false
      try {
        ws.ping()
      } catch {
        // ignore
      }
    })
  }, HEARTBEAT_INTERVAL_MS)

  wss.on('close', () => clearInterval(heartbeatInterval))

  // ── Connection handler ─────────────────────────────────────
  wss.on('connection', (ws, req) => {
    const remoteAddr =
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
    console.log(`[Terminal] New connection from ${remoteAddr}`)

    // Per-connection state
    ws._termAlive = true
    ws._termAuthed = false
    ws._termPty = null
    ws._termSessionId = null

    // Respond to pong
    ws.on('pong', () => {
      ws._termAlive = true
    })

    // ── Auth timeout ─────────────────────────────────────────
    const authTimer = setTimeout(() => {
      if (!ws._termAuthed) {
        safeSend(ws, { type: 'error', message: 'Authentication timeout' })
        ws.close(4001, 'Auth timeout')
      }
    }, AUTH_TIMEOUT_MS)

    // ── Cleanup helper ───────────────────────────────────────
    function cleanup() {
      clearTimeout(authTimer)
      if (ws._termPty) {
        try {
          ws._termPty.kill()
        } catch {
          // already dead
        }
        ws._termPty = null
      }
      if (ws._termSessionId) {
        activeSessions.delete(ws._termSessionId)
        console.log(
          `[Terminal] Session ${ws._termSessionId} ended (active: ${activeSessions.size}/${MAX_SESSIONS})`
        )
        ws._termSessionId = null
      }
    }

    ws.on('close', cleanup)
    ws.on('error', (err) => {
      console.error('[Terminal] WebSocket error:', err.message)
      cleanup()
    })

    // ── Message handler ──────────────────────────────────────
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        safeSend(ws, { type: 'error', message: 'Invalid JSON' })
        return
      }

      // Sanitise – only accept known types
      if (!msg || typeof msg.type !== 'string') {
        safeSend(ws, { type: 'error', message: 'Missing message type' })
        return
      }

      switch (msg.type) {
        // ── auth ──────────────────────────────────────────────
        case 'auth': {
          const adminToken = process.env.CHAT_ADMIN_TOKEN
          if (adminToken && msg.token !== adminToken) {
            safeSend(ws, { type: 'auth_failed' })
            ws.close(4003, 'Auth failed')
            return
          }
          ws._termAuthed = true
          ws._termPendingSpawn = true // Wait for resize before spawning
          clearTimeout(authTimer)
          safeSend(ws, { type: 'auth_success' })
          break
        }

        // ── input ─────────────────────────────────────────────
        case 'input': {
          if (!ws._termAuthed) {
            safeSend(ws, { type: 'error', message: 'Not authenticated' })
            return
          }
          if (!ws._termPty) {
            safeSend(ws, { type: 'error', message: 'Terminal not ready' })
            return
          }
          if (typeof msg.data !== 'string') return
          // Prevent excessively large writes
          if (msg.data.length > 4096) {
            safeSend(ws, { type: 'error', message: 'Input too large' })
            return
          }
          ws._termPty.write(msg.data)
          break
        }

        // ── resize ────────────────────────────────────────────
        case 'resize': {
          if (!ws._termAuthed) return
          const cols = parseInt(msg.cols, 10)
          const rows = parseInt(msg.rows, 10)
          if (
            !Number.isFinite(cols) || !Number.isFinite(rows) ||
            cols < 1 || cols > 500 || rows < 1 || rows > 200
          ) break

          // First resize after auth → spawn PTY with correct size
          if (ws._termPendingSpawn && !ws._termPty) {
            ws._termPendingSpawn = false
            spawnPty(ws, pty, cols, rows)
            break
          }

          if (ws._termPty) {
            try {
              ws._termPty.resize(cols, rows)
            } catch {
              // ignore resize errors on dead pty
            }
          }
          break
        }

        default:
          safeSend(ws, { type: 'error', message: `Unknown type: ${msg.type}` })
      }
    })
  })

  // ── Spawn PTY helper ───────────────────────────────────────
  function spawnPty(ws, pty, initialCols, initialRows) {
    // Build the session id
    const sessionId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    ws._termSessionId = sessionId
    activeSessions.add(sessionId)

    console.log(
      `[Terminal] Spawning PTY for session ${sessionId} (active: ${activeSessions.size}/${MAX_SESSIONS})`
    )

    // Decide what to spawn
    let shell, args
    const geminiAvailable = isGeminiAvailable()

    if (IS_WINDOWS) {
      shell = geminiAvailable ? 'powershell.exe' : 'powershell.exe'
      args = geminiAvailable
        ? ['-NoLogo', '-NoProfile', '-Command', 'gemini']
        : ['-NoLogo', '-NoProfile']
    } else {
      // Always use wrapper script on Linux — ensures Node 22 + correct env
      const wrapperPath = path.join(PROJECT_ROOT, 'scripts', 'gemini-wrapper.sh')
      const fs = require('fs')
      if (fs.existsSync(wrapperPath)) {
        shell = wrapperPath
        args = []
        console.log('[Terminal] Using gemini-wrapper.sh')
      } else if (geminiAvailable) {
        shell = 'gemini'
        args = []
      } else {
        // Fallback: interactive bash
        shell = 'bash'
        args = ['--login', '-i']
        console.warn('[Terminal] Gemini CLI not found – falling back to bash')
      }
    }

    // Construct env – inherit process.env but strip dangerous vars
    const env = Object.assign({}, process.env)
    // Remove variables that could leak secrets to the child
    delete env.CHAT_ADMIN_TOKEN
    delete env.OPENAI_API_KEY
    // Configure Gemini CLI to use our API proxy (Gemini→OpenAI→ZenMux/Claude)
    env.GOOGLE_GEMINI_BASE_URL = env.GOOGLE_GEMINI_BASE_URL || 'http://localhost:3002'
    env.GEMINI_API_KEY = env.GEMINI_API_KEY || 'proxy-mode'
    // Set a clear TERM
    env.TERM = 'xterm-256color'
    // Ensure Gemini CLI and Node 22 are on PATH (server may have them in user dirs)
    const homeDir = env.HOME || env.USERPROFILE || ''
    if (homeDir && !IS_WINDOWS) {
      const extraPaths = [
        homeDir + '/node22/bin',
        homeDir + '/.npm-global/bin',
        homeDir + '/.local/bin',
      ].join(':')
      env.PATH = extraPaths + ':' + (env.PATH || '')
    }

    let ptyProcess
    try {
      // Use client's actual terminal size
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: initialCols || 80,
        rows: initialRows || 24,
        cwd: PROJECT_ROOT,
        env,
      })
      console.log(`[Terminal] PTY size: ${initialCols || 80}x${initialRows || 24}`)
    } catch (err) {
      console.error('[Terminal] Failed to spawn PTY:', err.message)
      safeSend(ws, { type: 'error', message: 'Failed to start terminal' })
      activeSessions.delete(sessionId)
      ws._termSessionId = null
      ws.close(4500, 'Spawn failed')
      return
    }

    ws._termPty = ptyProcess

    // If gemini was not available, inform the user inside the terminal
    if (!geminiAvailable) {
      safeSend(ws, {
        type: 'output',
        data:
          '\r\n⚠  Gemini CLI not found on PATH. Opened a regular shell instead.\r\n' +
          '   Install Gemini CLI and reconnect to use it.\r\n\r\n',
      })
    }

    // PTY stdout -> WebSocket
    ptyProcess.onData((data) => {
      safeSend(ws, { type: 'output', data })
    })

    // PTY exit -> notify client & clean up
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(
        `[Terminal] PTY exited (code=${exitCode}, signal=${signal}) session=${sessionId}`
      )
      safeSend(ws, {
        type: 'output',
        data: `\r\n[Process exited with code ${exitCode}]\r\n`,
      })
      ws._termPty = null
      activeSessions.delete(sessionId)
      ws._termSessionId = null
      // Give the client a moment to read the exit message, then close
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'PTY exited')
        }
      }, 1000)
    })
  }

  console.log('[Terminal] WebSocket endpoint ready at /ws/terminal')
  return wss
}

module.exports = { initTerminalWebSocket }
