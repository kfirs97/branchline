/**
 * Renders the webview outside VS Code for visual checks:
 *   node tools/preview.js <repo> <out.html> [light|dark] [expandIndex]
 * Uses real git data + layout, a mocked VS Code API, and a VS Code-like theme.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Git, Ref } from '../src/git';
import { GraphLayout } from '../src/graph';
import type { Row } from '../src/protocol';

const [repo, out, theme = 'dark', expand] = process.argv.slice(2);

const THEMES: Record<string, Record<string, string>> = {
  dark: {
    foreground: '#cccccc', 'editor-background': '#1f1f1f', 'panel-border': '#2b2b2b', 'input-background': '#313131',
    'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'button-secondaryBackground': '#313131',
    'button-secondaryForeground': '#cccccc', 'list-hoverBackground': '#2a2d2e', 'list-inactiveSelectionBackground': '#37373d',
    'editorWidget-background': '#202020', 'menu-background': '#1f1f1f', 'menu-foreground': '#cccccc',
    'menu-selectionBackground': '#0078d4', 'menu-selectionForeground': '#ffffff', 'widget-shadow': 'rgba(0,0,0,.36)',
    'errorForeground': '#f85149', 'focusBorder': '#0078d4',
  },
  light: {
    foreground: '#3b3b3b', 'editor-background': '#ffffff', 'panel-border': '#e5e5e5', 'input-background': '#ffffff',
    'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'button-secondaryBackground': '#e5e5e5',
    'button-secondaryForeground': '#3b3b3b', 'list-hoverBackground': '#f2f2f2', 'list-inactiveSelectionBackground': '#e4e6f1',
    'editorWidget-background': '#f8f8f8', 'menu-background': '#ffffff', 'menu-foreground': '#3b3b3b',
    'menu-selectionBackground': '#0060c0', 'menu-selectionForeground': '#ffffff', 'widget-shadow': 'rgba(0,0,0,.16)',
    'errorForeground': '#e51400', 'focusBorder': '#0090f1',
  },
};

(async () => {
  const git = new Git(resolve(repo));
  const [state, commits] = await Promise.all([git.state(), git.log({ skip: 0, count: 120, allRefs: true })]);
  const byHash = new Map<string, Ref[]>();
  for (const r of state.refs) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r]);
  const layout = new GraphLayout();
  const rows: Row[] = [];
  if (state.dirty && state.head) {
    rows.push({ hash: '*', parents: [state.head], author: '', email: '', date: Date.now() / 1000, subject: `Uncommitted changes (${state.dirty})`, refs: [], layout: layout.add({ hash: '*', parents: [state.head] }) });
  }
  for (const c of commits) rows.push({ ...c, refs: byHash.get(c.hash) ?? [], layout: layout.add(c) });
  const expandHash = expand !== undefined ? rows[Number(expand)].hash : null;
  const details = expandHash ? await git.details(expandHash) : null;

  const vars = Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k}:${v};`).join('');
  const dist = resolve(__dirname, '../dist');
  const msg = { type: 'rows', reset: true, rows, hasMore: false,
    state: { repos: [git.cwd], repo: git.cwd, branch: state.branch, head: state.head, allRefs: true, search: '', dateFormat: 'relative' } };
  writeFileSync(out, `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>:root{${vars}--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,monospace}</style>
<style>${readFileSync(`${dist}/webview.css`, 'utf8')}</style></head><body><div id="app"></div>
<script>
  window.acquireVsCodeApi = () => ({ postMessage(m) {
    if (m.type === 'ready') setTimeout(() => {
      window.postMessage(${JSON.stringify(msg)}, '*');
      ${expandHash ? `setTimeout(() => document.querySelector('tr.commit[data-i="${expand}"]').click(), 50);` : ''}
    });
    if (m.type === 'details') window.postMessage(${JSON.stringify({ type: 'details', hash: expandHash, details })}, '*');
  }});
</script>
<script>${readFileSync(`${dist}/webview.js`, 'utf8')}</script></body></html>`);
  console.log(`wrote ${out}: ${rows.length} rows, max width ${Math.max(...rows.map(r => r.layout.width))}`);
})();
