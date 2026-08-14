'use strict'
/**
 * Code UI — package manifest.
 *
 * The two source halves (host.js / client.js) are kept as plain-JavaScript
 * **Cordis "function body"** sources — the exact format the DeepSeek Harness
 * dynamic plugin tool (`cordis_define`) consumes. Each file's top-level
 * `return { ... }` is the body of a function that produces a Cordis Plugin:
 *
 *   - host.js   -> Host half  (filesystem RPC: listDir / readFile / workspaceRoot)
 *   - client.js -> Client half (explorer overlay, diff panel, chat-right reorder)
 *
 * To install through the harness UI, submit these two bodies to `cordis_define`
 * (or paste them as the `code.host` / `code.client` of a Cordis Package). See
 * README.md for the full walkthrough and packaging notes.
 */
module.exports = {
  name: 'codeui',
  version: '1.0.0',
  description: 'VSCode-style code-change viewer for DeepSeek Harness (file explorer + green/red diff panel + chat on the right).',
  license: 'MIT',
  sources: {
    host: './host.js',
    client: './client.js',
  },
}
