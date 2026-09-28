import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { Git, GitError, Ref, RepoState } from './git';
import { GraphLayout } from './graph';
import { FromWebview, Row, ToWebview, ViewState, WORKING_TREE } from './protocol';
import { runCommitAction, runRefAction } from './actions';
import { revisionUri } from './content';

export class GraphPanel {
  static current: GraphPanel | undefined;

  private git: Git | null = null;
  private repoState: RepoState | null = null;
  private layout = new GraphLayout();
  private loaded = 0;
  private hasMore = false;
  private allRefs = true;
  private search = '';
  private loadSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, repos: () => Promise<string[]>): void {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('branchline.graph', 'Git Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    });
    GraphPanel.current = new GraphPanel(panel, context, repos);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly repos: () => Promise<string[]>,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch(e => this.showError(e)), null, this.disposables);
  }

  /** Reload the graph, keeping at least as many commits as are currently loaded. */
  async refresh(): Promise<void> {
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
        this.useRepo(repos.includes(last ?? '') ? last! : repos[0] ?? null);
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
        return this.openDiff(m.hash, m.file);
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

  private useRepo(repo: string | null): void {
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
    const [state, commits] = await Promise.all([
      git.state(),
      git.log({ skip, count: count + 1, allRefs: this.allRefs, search: this.search || undefined }),
    ]);
    if (seq !== this.loadSeq) return; // a newer load superseded this one

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
    if (reset && state.dirty > 0 && state.head && !this.search) {
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

  private viewState(repos: string[]): ViewState {
    return {
      repos,
      repo: this.git?.cwd ?? null,
      branch: this.repoState?.branch ?? null,
      head: this.repoState?.head ?? null,
      allRefs: this.allRefs,
      search: this.search,
      dateFormat: vscode.workspace.getConfiguration('branchline').get('dateFormat', 'relative'),
    };
  }

  private async openDiff(hash: string, file: import('./git').FileChange): Promise<void> {
    if (!this.git) return;
    const repo = this.git.cwd;
    const name = file.path.split('/').pop();
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
