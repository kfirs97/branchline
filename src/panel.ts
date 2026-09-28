import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Git, GitError, Ref, RepoState } from './git';
import { GraphLayout } from './graph';
import { FromWebview, Row, ToWebview, ViewState, WORKING_TREE } from './protocol';
import { runCommitAction, runRefAction } from './actions';
import { revisionUri } from './content';
import { License } from './license';

export class GraphPanel {
  static current: GraphPanel | undefined;

  private git: Git | null = null;
  private repoState: RepoState | null = null;
  private layout = new GraphLayout();
  private loaded = 0;
  private hasMore = false;
  private allRefs = true;
  private search = '';
  private path: string | null = null;
  private loadSeq = 0;
  /** Identity of the loaded refs/HEAD/working-tree state, to skip reloads when nothing relevant changed. */
  private fingerprint = '';
  private offeredSpeedup = false;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, repos: () => Promise<string[]>, license: License): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('branchline.graph', 'Git Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    GraphPanel.current = new GraphPanel(panel, context, repos, license);
    return GraphPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly repos: () => Promise<string[]>,
    private readonly license: License,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    license.onDidChange(() => void this.load(true), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch(e => this.showError(e)), null, this.disposables);
  }

  /** Shows only the history of `file` (an absolute path inside one of the repos). */
  async showFileHistory(file: string): Promise<void> {
    const repos = await this.repos();
    const repo = repos.filter(r => file === r || file.startsWith(r + '/') || file.startsWith(r + '\\')).sort((a, b) => b.length - a.length)[0];
    if (!repo) return void vscode.window.showWarningMessage('This file is not inside a git repository in the workspace.');
    this.useRepo(repo);
    this.path = file.slice(repo.length + 1).split('\\').join('/');
    this.search = '';
    await this.load(true, true);
  }

  /**
   * Reload the graph, keeping at least as many commits as are currently loaded.
   * Automatic refreshes (file saves, index changes) skip the reload when HEAD, refs and the
   * uncommitted-changes row are unchanged.
   */
  async refresh(force = true): Promise<void> {
    if (!force && this.git && this.fingerprint) {
      const state = await this.git.state();
      if (fingerprintOf(state) === this.fingerprint) {
        if (state.dirty !== this.repoState?.dirty) {
          this.repoState = state;
    this.fingerprint = fingerprintOf(state);
          this.post({ type: 'dirty', count: state.dirty });
        }
        return;
      }
    }
    await this.load(true);
  }

  private post(msg: ToWebview): void {
    void this.panel.webview.postMessage(msg);
  }

  private showError(e: unknown): void {
    const message = e instanceof GitError || e instanceof Error ? e.message : String(e);
    this.post({ type: 'error', message });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const repos = await this.repos();
        const last = this.context.workspaceState.get<string>('branchline.repo');
        if (!this.git) this.useRepo(repos.includes(last ?? '') ? last! : repos[0] ?? null);
        return this.load(true);
      }
      case 'selectRepo':
        this.useRepo(m.repo);
        return this.load(true);
      case 'refresh':
        return this.load(true);
      case 'loadMore':
        return this.load(false);
      case 'setFilter':
        this.allRefs = m.allRefs;
        this.search = m.search;
        return this.load(true, true);
      case 'fetch':
        if (!this.git) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Fetching from all remotes…' },
          () => this.git!.run(['fetch', '--all', '--prune']),
        );
        return this.load(true);
      case 'details': {
        if (!this.git) return;
        const details = m.hash === WORKING_TREE
          ? { hash: WORKING_TREE, files: await this.git.changes(null, null) }
          : await this.git.details(m.hash);
        this.post({ type: 'details', hash: m.hash, details });
        return;
      }
      case 'openDiff':
        return this.openDiff(m.hash, m.file, m.base);
      case 'compare': {
        if (!this.git || !(await this.license.require('Comparing commits'))) return;
        // Order the pair so the diff reads older → newer.
        const [from, to] = (await this.isAncestor(m.to, m.from)) ? [m.to, m.from] : [m.from, m.to];
        this.post({ type: 'comparison', comparison: { from, to, files: await this.git.changes(from, to === WORKING_TREE ? null : to) } });
        return;
      }
      case 'clearPath':
        this.path = null;
        return this.load(true, true);
      case 'getPro':
        if (!this.license.isPro) await this.license.require('Branchline Pro');
        return;
      case 'openFile':
        if (this.git) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(this.git.cwd), m.path));
        return;
      case 'commitAction':
        if (this.git && (await runCommitAction(this.git, m.action, m.hash, m.subject))) await this.load(true);
        return;
      case 'refAction':
        if (this.git && this.repoState && (await runRefAction(this.git, m.action, m.ref, this.repoState))) await this.load(true);
        return;
    }
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    if (a === WORKING_TREE) return false;
    if (b === WORKING_TREE) return true;
    try {
      await this.git!.run(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  private useRepo(repo: string | null): void {
    if (repo !== this.git?.cwd) this.path = null;
    this.git = repo ? new Git(repo, vscode.workspace.getConfiguration('git').get<string>('path') || 'git') : null;
    if (repo) void this.context.workspaceState.update('branchline.repo', repo);
    this.panel.title = repo ? `Git Graph: ${repo.split(/[\\/]/).pop()}` : 'Git Graph';
  }

  private async load(reset: boolean, dropLoaded = false): Promise<void> {
    const seq = ++this.loadSeq;
    const pageSize = vscode.workspace.getConfiguration('branchline').get<number>('pageSize', 300);
    const repos = await this.repos();
    const git = this.git;
    if (!git) {
      this.post({ type: 'rows', reset: true, state: this.viewState(repos), rows: [], hasMore: false });
      return;
    }
    if (reset) this.post({ type: 'loading' });

    const count = reset ? Math.max(pageSize, dropLoaded ? 0 : this.loaded) : pageSize;
    const skip = reset ? 0 : this.loaded;
    const started = Date.now();
    const [state, commits] = await Promise.all([
      git.state(),
      git.log({ skip, count: count + 1, allRefs: this.allRefs, search: this.search || undefined, path: this.path ?? undefined }),
    ]);
    if (seq !== this.loadSeq) return; // a newer load superseded this one
    if (reset && commits.length > count) void this.offerSpeedup(git, Date.now() - started);

    const hasMore = commits.length > count;
    if (hasMore) commits.pop();
    if (reset) {
      this.layout = new GraphLayout();
      this.loaded = 0;
    }
    this.repoState = state;

    const refsByHash = new Map<string, Ref[]>();
    for (const ref of state.refs) {
      const list = refsByHash.get(ref.hash) ?? [];
      list.push(ref);
      refsByHash.set(ref.hash, list);
    }

    const rows: Row[] = [];
    if (reset && state.dirty > 0 && state.head && !this.search && !this.path) {
      rows.push({
        hash: WORKING_TREE, parents: [state.head], author: '', email: '', date: Date.now() / 1000,
        subject: `Uncommitted changes (${state.dirty})`, refs: [],
        layout: this.layout.add({ hash: WORKING_TREE, parents: [state.head] }),
      });
    }
    for (const c of commits) {
      // While searching, rows are not contiguous history, so draw them unconnected.
      const layout = this.search ? { col: 0, color: 0, segments: [], width: 1 } : this.layout.add(c);
      rows.push({ ...c, refs: refsByHash.get(c.hash) ?? [], layout });
    }
    this.loaded += commits.length;
    this.hasMore = hasMore;
    this.post({ type: 'rows', reset, state: this.viewState(repos), rows, hasMore: this.hasMore });
  }

  /** Offers once per repo to build git's commit-graph cache when history loads slowly. */
  private async offerSpeedup(git: Git, ms: number): Promise<void> {
    const key = `branchline.speedupOffered:${git.cwd}`;
    if (ms < 500 || this.offeredSpeedup || this.context.workspaceState.get(key) || (await git.hasCommitGraph())) return;
    this.offeredSpeedup = true;
    const pick = await vscode.window.showInformationMessage(
      'This repository has a large history. Git Graph can load much faster if git builds its commit-graph cache (git commit-graph write).',
      'Speed Up',
      "Don't Ask Again",
    );
    if (pick === "Don't Ask Again") await this.context.workspaceState.update(key, true);
    if (pick !== 'Speed Up') return;
    await this.context.workspaceState.update(key, true);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Building git commit-graph…' },
      () => git.run(['commit-graph', 'write', '--reachable']),
    );
    await this.load(true);
  }

  private viewState(repos: string[]): ViewState {
    return {
      repos,
      repo: this.git?.cwd ?? null,
      branch: this.repoState?.branch ?? null,
      head: this.repoState?.head ?? null,
      allRefs: this.allRefs,
      search: this.search,
      path: this.path,
      pro: this.license.isPro,
      dateFormat: vscode.workspace.getConfiguration('branchline').get('dateFormat', 'relative'),
    };
  }

  private async openDiff(hash: string, file: import('./git').FileChange, base?: string): Promise<void> {
    if (!this.git) return;
    const repo = this.git.cwd;
    const name = file.path.split('/').pop();
    if (base !== undefined) {
      const left = file.status === 'A' ? revisionUri(repo, '', file.path) : revisionUri(repo, base, file.oldPath ?? file.path);
      const right = file.status === 'D'
        ? revisionUri(repo, '', file.path)
        : hash === WORKING_TREE ? vscode.Uri.joinPath(vscode.Uri.file(repo), file.path) : revisionUri(repo, hash, file.path);
      const label = (h: string) => (h === WORKING_TREE ? 'Working Tree' : h.slice(0, 7));
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${label(base)} ↔ ${label(hash)})`);
      return;
    }
    if (hash === WORKING_TREE) {
      const right = file.status === 'D' ? revisionUri(repo, '', file.path) : vscode.Uri.joinPath(vscode.Uri.file(repo), file.path);
      if (file.status === 'U' || file.status === 'A') return void vscode.window.showTextDocument(right);
      const left = revisionUri(repo, 'HEAD', file.oldPath ?? file.path);
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ Working Tree)`);
      return;
    }
    const parent = (await this.git.run(['rev-list', '--parents', '-n1', hash])).trim().split(' ')[1] ?? null;
    const short = hash.slice(0, 7);
    const left = parent && file.status !== 'A' ? revisionUri(repo, parent, file.oldPath ?? file.path) : revisionUri(repo, '', file.path);
    const right = file.status === 'D' ? revisionUri(repo, '', file.path) : revisionUri(repo, hash, file.path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${parent ? parent.slice(0, 7) : 'empty'} ↔ ${short})`);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Git Graph</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    GraphPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function fingerprintOf(state: RepoState): string {
  const refs = state.refs.map(r => `${r.type}:${r.name}:${r.hash}`).sort().join(',');
  return `${state.head}|${state.branch}|${state.dirty > 0}|${refs}`;
}
