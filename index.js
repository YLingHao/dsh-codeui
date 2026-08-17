'use strict'
/**
 * Code UI — package manifest.
 *
 * The two source halves (host.js / client.js) are kept as plain-JavaScript
 * **Cordis "function body"** sources — the exact format the DeepSeek Harness
 * dynamic plugin tool (`cordis_define`) consumes. Each file's top-level
 * `return { ... }` is the body of a function that produces a Cordis Plugin:
 *
 *   - host.js   -> Host half  (filesystem RPC: listDir / readFile / workspaceRoot,
 *                 plus read-only Git RPC: gitStatus / gitDiff)
 *   - client.js -> Client half (explorer + Git badges, per-turn split diff,
 *                 turn snapshots, always-on jump rail, chat-right reorder)
 *
 * To install through the harness UI, submit these two bodies to `cordis_define`
 * (or paste them as the `code.host` / `code.client` of a Cordis Package). See
 * README.md for the full walkthrough and packaging notes.
 */
module.exports = {
  name: 'codeui',
  version: '2.14.4',
  description: 'DeepSeek Harness code-review workbench: per-turn Review cards, right-side resizable Review panel, and turn jump rail.',
  license: 'MIT',
  sources: {
    host: './host.js',
    client: './client.js',
  },
}
