/**
 * Code UI — static host half (dsh-codeui).
 *
 * A Cordis plugin (ESM, named exports `name` / `apply`) installed as a row in
 * a dsh composition (`name: 'dsh-codeui'`). The browser half ships through
 * `exports["./client"]` and is discovered via the `dsh.client` manifest in
 * package.json (see @deepseek-ai/dsh-client-modules).
 *
 * Client -> Host bridge: same-origin HTTP. This plugin registers a
 * `/codeui/api/*` route through `ctx.webServer`; the client bundle calls it
 * with fetch + JSON bodies. File browsing and Git operations are read-only;
 * `writeFile` is the single mutation and uses the fs service's atomic,
 * version-guarded replacement:
 *
 *   POST /codeui/api/listDir        { path }
 *   POST /codeui/api/readFile       { path }
 *   POST /codeui/api/writeFile      { path, content, version, workspaceRoot }
 *   POST /codeui/api/workspaceRoot  {}
 *   POST /codeui/api/gitStatus      { path }
 *   POST /codeui/api/gitDiff        { path }
 *
 * Git integration runs two fixed read-only commands only (`git status` /
 * `git diff HEAD`) through the harness `bash` service when present, falling
 * back to the `shell` service. Git is never mutated, committed, or checked
 * out.
 */

export const name = 'dsh-codeui'
export const inject = ['fs', 'webServer']

const turnHistoryCache = new Map()
const TURN_HISTORY_CACHE_TTL = 5 * 60 * 1000

export function apply(ctx) {
  const fs = ctx.get('fs')
  if (fs === undefined) return

  const webServer = ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') return

  const errText = (e) => (e && typeof e.message === 'string') ? e.message : String(e)

  const json = (res, code, data) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  const originOk = (req) => {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const u = new URL(origin)
      return String(req.headers.host || '') === u.host
    } catch (e) {
      return false
    }
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 12000000) {
        reject(new Error('body too large'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => { try { resolve(Buffer.concat(chunks).toString('utf8')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })

  // ---------- read-only Git integration (graceful degradation) ----------
  async function runGit(root, command, maxBytes) {
    const bash = ctx.get('bash')
    const shell = ctx.get('shell')
    const canBash = bash && typeof bash.run === 'function'
    const canShell = shell && typeof shell.run === 'function' && typeof shell.resolve === 'function'
    if (!canBash && !canShell) return { ok: false, error: 'bash-unavailable' }
    try {
      const target = await fs.resolve(root)
      const workdir = (target && typeof target.displayPath === 'string') ? target.displayPath : String(root || '')
      const request = { command: command, workdir: workdir, timeoutMs: 12000, stdoutMaxBytes: maxBytes }
      const result = canBash ? await bash.run(request) : await shell.run(shell.resolve(request))
      const text = result && result.stdout && typeof result.stdout.text === 'string'
        ? result.stdout.text
        : (typeof result.stdout === 'string' ? result.stdout : '')
      if (result && result.timedOut) return { ok: false, error: 'git-timeout' }
      if (result && result.exitCode !== null && result.exitCode !== 0) {
        const err = result && result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : ''
        return { ok: false, error: 'git-exit-' + result.exitCode + (err ? ':' + err.slice(0, 200) : '') }
      }
      return { ok: true, text: text }
    } catch (e) {
      return { ok: false, error: errText(e) }
    }
  }

  function parsePorcelainStatus(text) {
    const parts = String(text || '').split('\0')
    let branch = ''
    let upstream = null
    let ahead = 0
    let behind = 0
    const entries = []
    for (const raw of parts) {
      if (raw === '') continue
      if (raw.startsWith('## ')) {
        const body = raw.slice(3)
        const upstreamAt = body.indexOf('...')
        if (upstreamAt >= 0) {
          branch = body.slice(0, upstreamAt).trim()
          const rest = body.slice(upstreamAt + 3)
          const sp = rest.indexOf(' ')
          upstream = (sp >= 0 ? rest.slice(0, sp) : rest).trim()
        } else {
          branch = body.replace(/^No commits yet on\s+/, '').split(' ')[0].trim()
        }
        const m = body.match(/ahead\s+(\d+)/)
        if (m) ahead = Number(m[1]) || 0
        const b = body.match(/behind\s+(\d+)/)
        if (b) behind = Number(b[1]) || 0
        continue
      }
      if (raw.length < 3) continue
      entries.push({ x: raw.slice(0, 1), y: raw.slice(1, 2), path: raw.slice(3) })
    }
    return { branch: branch, upstream: upstream, ahead: ahead, behind: behind, entries: entries }
  }

  function summarizeSessionTurns(events) {
    const turns = []
    const byNumber = new Map()
    const addTurn = (t) => {
      if (!t || typeof t.turn !== 'number' || byNumber.has(t.turn)) return
      byNumber.set(t.turn, t)
      turns.push(t)
    }
    const userMessages = []
    const turnFiles = new Map()
    const addFileDelta = (turn, path, added, removed, op, seq, time) => {
      if (typeof turn !== 'number' || typeof path !== 'string' || path === '' || (!added && !removed)) return
      if (op) {
        op.turn = turn
        if (typeof seq === 'number') op.seq = seq
        if (typeof time === 'number') op.time = time
      }
      let cell = turnFiles.get(turn)
      if (!cell) { cell = { map: new Map(), added: 0, removed: 0 }; turnFiles.set(turn, cell) }
      let row = cell.map.get(path)
      if (!row) { row = { path: path, added: 0, removed: 0, ops: [] }; cell.map.set(path, row) }
      row.added += added
      row.removed += removed
      if (op) row.ops.push(op)
      cell.added += added
      cell.removed += removed
    }
const lineCount = (text) => {
      const s = text == null || text === '' ? '' : String(text)
      return s === '' ? 0 : s.split('\n').length
    }
    for (const event of events) {
      if (!event || !event.data) continue
      const d = event.data
      if (event.type === 'turn/start') {
        addTurn({ turn: d.turn, startSeq: event.seq, endSeq: null, startTime: event.time, endTime: null, status: 'open' })
      } else if (event.type === 'turn/end') {
        let t = byNumber.get(d.turn)
        if (!t) { t = { turn: d.turn, startSeq: null, endSeq: null, startTime: null, endTime: null, status: 'closed' }; addTurn(t) }
        t.endSeq = event.seq
        t.endTime = event.time
        t.status = 'closed'
      } else if (event.type === 'user/message' && d.source && d.source.kind === 'user') {
        userMessages.push({ seq: event.seq, time: event.time, content: Array.isArray(d.content) ? d.content : [] })
      } else if (event.type === 'tool/call') {
        let args = null
        try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments } catch (e) {}
        if (args && typeof args === 'object' && typeof d.turn === 'number') {
          const path = (typeof args.file_path === 'string' && args.file_path !== '') ? args.file_path : ((typeof args.path === 'string' && args.path !== '') ? args.path : '')
            if (path) {
              if (d.name === 'write') addFileDelta(d.turn, path, lineCount(args.content), 0, { op: 'write', turn: d.turn, content: typeof args.content === 'string' ? args.content : '' }, event.seq, event.time)
              else if (d.name === 'edit') addFileDelta(d.turn, path, lineCount(args.new_string), lineCount(args.old_string), { op: 'edit', turn: d.turn, oldStr: typeof args.old_string === 'string' ? args.old_string : '', newStr: typeof args.new_string === 'string' ? args.new_string : '', replaceAll: !!(args.replace_all === true) }, event.seq, event.time)
              else if (d.name === 'str_replace_editor') {
                if (args.command === 'create') addFileDelta(d.turn, path, lineCount(args.file_text), 0, { op: 'write', turn: d.turn, content: typeof args.file_text === 'string' ? args.file_text : '' }, event.seq, event.time)
                else if (args.command === 'str_replace') addFileDelta(d.turn, path, lineCount(args.new_str), lineCount(args.old_str), { op: 'edit', turn: d.turn, oldStr: typeof args.old_str === 'string' ? args.old_str : '', newStr: typeof args.new_str === 'string' ? args.new_str : '', replaceAll: !!(args.replace_all === true) }, event.seq, event.time)
                else if (args.command === 'insert') addFileDelta(d.turn, path, lineCount(args.text), 0, { op: 'insert', turn: d.turn, line: args.insert_line, text: typeof args.text === 'string' ? args.text : (typeof args.new_str === 'string' ? args.new_str : '') }, event.seq, event.time)
              }
            }
            }
          } else if (event.type === 'turn-error') {
            const t = byNumber.get(d.turn)
            if (t) t.error = true
          } else if (event.type === 'turn-max-tokens') {
        const t = byNumber.get(d.turn)
        if (t) t.warning = true
      }
    }
    turns.sort((a, b) => a.turn - b.turn)
    const turnForSeq = (seq) => {
      let best = null
      for (const t of turns) {
        if (t.startSeq != null && seq < t.startSeq) break
        if (t.startSeq == null) continue
        if (t.endSeq == null || seq <= t.endSeq) best = t.turn
      }
      return best != null ? best : (turns.length ? turns[0].turn : 1)
    }
    for (let i = 0; i < userMessages.length; i++) {
      const m = userMessages[i]
      const turn = turnForSeq(m.seq)
      let t = byNumber.get(turn)
      if (!t) { t = { turn: turn, startSeq: null, endSeq: null, startTime: null, endTime: null, status: 'unknown' }; addTurn(t) }
      if (t.userSeq == null) {
        let text = ''
        for (const block of m.content) if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
        t.userSeq = m.seq
        t.userIndex = i
        t.userTitle = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 96)
        t.userFull = text.length > 600 ? text.slice(0, 600) + '…' : text
      }
    }
    turns.sort((a, b) => a.turn - b.turn)
    let latestTurn = turns.length ? turns[turns.length - 1].turn : 0
    let lastClosedTurn = 0
    for (const t of turns) {
      if (t.endSeq != null) lastClosedTurn = Math.max(lastClosedTurn, t.turn)
      if (t.error) t.status = 'error'
      else if (t.warning) t.status = 'warning'
      else if (t.endSeq != null) t.status = 'done'
      else t.status = 'running'
      const cell = turnFiles.get(t.turn)
      if (cell) {
        const files = Array.from(cell.map.values())
        files.sort((a, b) => ((b.added + b.removed) - (a.added + a.removed)) || String(a.path).localeCompare(String(b.path)))
        t.files = files
        t.fileCount = files.length
        t.added = cell.added
        t.removed = cell.removed
      } else {
        t.files = []
        t.fileCount = 0
        t.added = 0
        t.removed = 0
      }
      t.title = t.userTitle || '用户提问'
    }
    return { sessionId: '', turns: turns, latestTurn: latestTurn, lastClosedTurn: lastClosedTurn, hasMore: false, running: false }
  }


  const handlers = {
    async listDir(args) {
      const path = (args && typeof args.path === 'string') ? args.path : ''
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      if (!info || info.type !== 'directory') return { ok: false, error: 'not-a-directory' }
      const entries = await fs.listDir(target)
      const dirs = []
      const files = []
      for (const e of entries) {
        const item = { name: e.name, path: e.target.displayPath, size: (typeof e.size === 'number') ? e.size : 0 }
        if (e.type === 'directory') dirs.push(item)
        else files.push(item)
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name))
      files.sort((a, b) => a.name.localeCompare(b.name))
      return { ok: true, path: target.displayPath, dirs: dirs, files: files }
    },
    async readFile(args) {
      const path = (args && typeof args.path === 'string') ? args.path : ''
      const target = await fs.resolve(path)
      // Return content and a matching version token so the editor can reject
      // stale autosaves instead of overwriting a concurrent agent/IDE change.
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await fs.stat(target)
        if (!before || before.type !== 'file') return { ok: false, error: 'not-a-file' }
        // Review reconstruction needs the current full text for historical
        // edit-only files; a 1 MB cap silently turned those files into +0/-0.
        if (typeof before.size === 'number' && before.size > 10000000) return { ok: false, error: 'file-too-large' }
        const content = await fs.readText(target)
        const after = await fs.stat(target)
        if (after && after.type === 'file' && String(before.version) === String(after.version)) {
          return { ok: true, path: target.displayPath, content: content, version: String(after.version) }
        }
      }
      return { ok: false, error: 'file-changing' }
    },
    async writeFile(args) {
      const path = (args && typeof args.path === 'string') ? args.path : ''
      const content = (args && typeof args.content === 'string') ? args.content : null
      const version = (args && typeof args.version === 'string') ? args.version : ''
      const workspaceRoot = (args && typeof args.workspaceRoot === 'string') ? args.workspaceRoot : ''
      if (!path) return { ok: false, error: 'missing-path' }
      if (content == null) return { ok: false, error: 'missing-content' }
      if (!version) return { ok: false, error: 'missing-version' }
      if (!workspaceRoot) return { ok: false, error: 'missing-workspace-root' }
      if (Buffer.byteLength(content, 'utf8') > 10000000) return { ok: false, error: 'file-too-large' }
      const target = await fs.resolve(path)
      const rootTarget = await fs.resolve(workspaceRoot)
      const insideWorkspace = typeof fs.contains === 'function' && await fs.contains(rootTarget, target)
      if (!insideWorkspace) return { ok: false, error: 'FS_SANDBOX_DENIED' }
      const info = await fs.stat(target)
      if (!info || info.type !== 'file') return { ok: false, error: 'not-a-file' }
      try {
        // This is an explicit user edit. The canonical containment check above
        // binds the request to the active Review workspace; the sandbox repeats
        // that check immediately before the atomic replacement.
        const policy = { mode: 'workspace-write', workspaceRoot: rootTarget.displayPath }
        const result = await fs.writeText(target, content, { kind: 'replaceIfVersion', version: version }, undefined, policy)
        return { ok: true, path: target.displayPath, content: result.after, version: String(result.version) }
      } catch (e) {
        return { ok: false, error: (e && typeof e.code === 'string') ? e.code : errText(e) }
      }
    },
    async workspaceRoot() {
      const sp = ctx.get('sandboxPolicy')
      if (sp && typeof sp.workspaceRoot === 'string') return { ok: true, root: sp.workspaceRoot }
      return { ok: true, root: '' }
    },
    async gitStatus(args) {
      const path = (args && typeof args.path === 'string') ? args.path : ''
      const target = await fs.resolve(path)
      const root = (target && typeof target.displayPath === 'string') ? target.displayPath : String(path || '')
      const top = await runGit(root, 'git rev-parse --show-toplevel', 20000)
      const repoRoot = top.ok ? String(top.text || '').trim() : root
      let r = await runGit(root, 'git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z --branch', 400000)
      if (!r.ok) {
        const fallback = await runGit(root, 'git -c core.quotepath=false -c diff.renames=false status --porcelain=v1 -z', 400000)
        if (!fallback.ok) return r
        const parsedFallback = parsePorcelainStatus(fallback.text)
        return { ok: true, root: root, repoRoot: repoRoot || root, branch: '', upstream: null, ahead: 0, behind: 0, entries: parsedFallback.entries, degraded: true }
      }
      const parsed = parsePorcelainStatus(r.text)
      return { ok: true, root: root, repoRoot: repoRoot || root, branch: parsed.branch, upstream: parsed.upstream, ahead: parsed.ahead, behind: parsed.behind, entries: parsed.entries }
    },
    async gitDiff(args) {
      const path = (args && typeof args.path === 'string') ? args.path : ''
      const target = await fs.resolve(path)
      const root = (target && typeof target.displayPath === 'string') ? target.displayPath : String(path || '')
      const r = await runGit(root, 'git -c core.quotepath=false diff --no-ext-diff --unified=3 HEAD -- .', 1500000)
      if (r.ok) return { ok: true, root: root, diff: r.text || '' }
      const err = String(r.error || '').toLowerCase()
      if (/not a git repository/.test(err)) return r
      if (/head|bad revision|unknown revision|ambiguous argument|git-exit-1/.test(err)) {
        const cached = await runGit(root, 'git -c core.quotepath=false diff --no-ext-diff --unified=3 --cached -- .', 1500000)
        if (cached.ok) return { ok: true, root: root, diff: cached.text || '', fallback: 'cached' }
        return { ok: true, root: root, diff: '', fallback: 'empty' }
      }
      return r
    },
      async turnHistory(args) {
        const id = (args && typeof args.sessionId === 'string') ? args.sessionId : ''
        if (!id) return { ok: false, error: 'missing-sessionId' }
        const now = Date.now()
        const hit = turnHistoryCache.get(id)
        if (hit && hit.expiresAt > now) return hit.payload
        const persistence = ctx.get('sessionPersistence')
        if (!persistence || typeof persistence.readFrom !== 'function') return { ok: false, error: 'session-history-unavailable' }
        let stored
        if (typeof persistence.inspect === 'function') {
          try { stored = await persistence.inspect(id) } catch (e) { stored = null }
        }
        if (!stored) stored = await persistence.readFrom(id, 0)
        const events = Array.isArray(stored) ? stored : (stored && Array.isArray(stored.events) ? stored.events : [])
        const summary = summarizeSessionTurns(events)
        summary.sessionId = id
        const payload = { ok: true, ...summary }
        turnHistoryCache.set(id, { payload: payload, expiresAt: now + TURN_HISTORY_CACHE_TTL })
        if (turnHistoryCache.size > 30) {
          const oldest = Array.from(turnHistoryCache.keys()).sort(function (a, b) { return turnHistoryCache.get(a).expiresAt - turnHistoryCache.get(b).expiresAt })[0]
          if (oldest !== undefined) turnHistoryCache.delete(oldest)
        }
        return payload
      },

  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/codeui/api', handler: async (req, res) => {
    try {
      if (!originOk(req)) return json(res, 403, { ok: false, error: 'cross-origin request rejected' })
      const u = new URL(req.url || '/', 'http://local')
      const name = u.pathname.slice('/codeui/api/'.length)
      const handler = handlers[name]
      if (!handler) return json(res, 404, { ok: false, error: 'not found: ' + u.pathname })
      if (String(req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readBody(req)
      let args = {}
      try { args = body ? JSON.parse(body) : {} } catch (e) { return json(res, 400, { ok: false, error: 'invalid JSON body' }) }
      try {
        return json(res, 200, await handler(args))
      } catch (e) {
        return json(res, 200, { ok: false, error: errText(e) })
      }
    } catch (err) {
      return json(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  } }))
}
