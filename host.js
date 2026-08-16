/**
 * Code UI 鈥?Host half.
 *
 * Provides Package-private JSON methods (Client -> Host):
 *   - codeui.listDir        list one directory (folders first, then files)
 *   - codeui.readFile       read a UTF-8 text file (size-capped)
 *   - codeui.workspaceRoot  current workspace root (explorer fallback)
 *   - codeui.gitStatus      read-only `git status` for tree badges (graceful
 *                           degradation when the bash service or Git is absent)
 *   - codeui.gitDiff        read-only `git diff HEAD` for patch export
 *
 * Everything else (the diff extraction and rendering) runs on the Client using
 * the conversation snapshot: the `edit` / `write` tools already ship a
 * `card: 'diff'` result view with `{ path, oldText, newText }`, so the Host
 * does not need to recompute diffs.
 *
 * This is a plain-JavaScript function body that returns a Cordis Plugin.
 */
return {
  apply(ctx) {
    const fs = ctx.get('fs')
    if (fs === undefined) return

    const errText = (e) => (e && typeof e.message === 'string') ? e.message : String(e)

    // List one directory: folders first, then files (name-sorted).
    harness.handle('codeui.listDir', async (args) => {
      try {
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
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    })

    // Read a UTF-8 text file for the explorer preview (size-capped).
    harness.handle('codeui.readFile', async (args) => {
      try {
        const path = (args && typeof args.path === 'string') ? args.path : ''
        const target = await fs.resolve(path)
        const info = await fs.stat(target)
        if (info && typeof info.size === 'number' && info.size > 1000000) return { ok: false, error: 'file-too-large' }
        const content = await fs.readText(target)
        return { ok: true, path: target.displayPath, content: content }
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    })

    // Current working folder (workspace root) as an explorer fallback.
    harness.handle('codeui.workspaceRoot', async () => {
      const sp = ctx.get('sandboxPolicy')
      if (sp && typeof sp.workspaceRoot === 'string') return { ok: true, root: sp.workspaceRoot }
      return { ok: true, root: '' }
    })

    // ---------- read-only Git integration (graceful degradation) ----------
    // Uses the harness `bash` service when present, falling back to `shell`,
    // for two fixed, read-only commands only: `git status` (file tree badges)
    // and `git diff HEAD` (cumulative patch). Nothing is ever written,
    // committed, or checked out.
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
          t.title = t.userTitle || '用户提问'
        }
        return { sessionId: '', turns: turns, latestTurn: latestTurn, lastClosedTurn: lastClosedTurn, hasMore: false, running: false }
      }

      harness.handle('codeui.turnHistory', async (args) => {
        try {
          const id = (args && typeof args.sessionId === 'string') ? args.sessionId : ''
          if (!id) return { ok: false, error: 'missing-sessionId' }
          const persistence = ctx.get('sessionPersistence')
          if (!persistence || typeof persistence.readFrom !== 'function') return { ok: false, error: 'session-history-unavailable' }
          const stored = await persistence.readFrom(id, 0)
          const events = Array.isArray(stored) ? stored : (stored && Array.isArray(stored.events) ? stored.events : [])
          const summary = summarizeSessionTurns(events)
          summary.sessionId = id
          return { ok: true, turns: summary.turns, latestTurn: summary.latestTurn, lastClosedTurn: summary.lastClosedTurn }
        } catch (e) {
          return { ok: false, error: errText(e) }
        }
      })


    // Git status for the workspace file tree (M/A/U/D/... badges).
    harness.handle('codeui.gitStatus', async (args) => {
      try {
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
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    })

    // Cumulative unified diff since HEAD (exportable patch).
    harness.handle('codeui.gitDiff', async (args) => {
      try {
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
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    })

  },
}
