/**
 * Code UI — Host half.
 *
 * Provides three Package-private JSON methods (Client -> Host):
 *   - codeui.listDir      list one directory (folders first, then files)
 *   - codeui.readFile     read a UTF-8 text file (size-capped)
 *   - codeui.workspaceRoot  current workspace root (explorer fallback)
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
  },
}
