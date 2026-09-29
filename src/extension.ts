import * as vscode from 'vscode';
import { GraphPanel } from './panel';
import { RevisionContentProvider, SCHEME } from './content';
import { Git } from './git';
import { License } from './license';
import { BUY_URL } from './licenseVerify';
import { recordGraphOpen } from './nudge';

/** The subset of the built-in git extension's API (vscode.git, API v1) that we use. */
interface BuiltinGitApi {
  repositories: { rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> } }[];
  onDidOpenRepository: vscode.Event<{ rootUri: vscode.Uri; state: { onDidChange: vscode.Event<void> } }>;
  onDidCloseRepository: vscode.Event<unknown>;
}

async function builtinGit(): Promise<BuiltinGitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): BuiltinGitApi }>('vscode.git');
  if (!ext) return undefined;
  try {
    return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  } catch {
    return undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const api = await builtinGit();
  const license = new License(context);
  await license.init();

  const repos = async (): Promise<string[]> => {
    const found = new Set<string>(api?.repositories.map(r => r.rootUri.fsPath) ?? []);
    if (found.size === 0) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const top = await Git.topLevel(folder.uri.fsPath);
        if (top) found.add(top);
      }
    }
    return [...found].sort();
  };

  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void GraphPanel.current?.refresh(false), 400);
  };

  if (api) {
    const watch = (repo: { state: { onDidChange: vscode.Event<void> } }) => context.subscriptions.push(repo.state.onDidChange(scheduleRefresh));
    api.repositories.forEach(watch);
    context.subscriptions.push(
      api.onDidOpenRepository(r => { watch(r); scheduleRefresh(); }),
      api.onDidCloseRepository(scheduleRefresh),
    );
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(git-branch) Git Graph';
  status.tooltip = 'Show Git Graph (Branchline)';
  status.command = 'branchline.show';
  const updateStatus = () =>
    vscode.workspace.getConfiguration('branchline').get('showStatusBarItem', true) ? status.show() : status.hide();
  updateStatus();

  context.subscriptions.push(
    status,
    { dispose: () => clearTimeout(timer) },
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider()),
    vscode.commands.registerCommand('branchline.show', () => {
      GraphPanel.show(context, repos, license);
      void recordGraphOpen(context, license);
    }),
    vscode.commands.registerCommand('branchline.fileHistory', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme !== 'file') return void vscode.window.showWarningMessage('Open or select a file to see its history.');
      if (!(await license.require('File history'))) return;
      await GraphPanel.show(context, repos, license).showFileHistory(target.fsPath);
    }),
    vscode.commands.registerCommand('branchline.enterLicense', () => license.enterKey()),
    vscode.commands.registerCommand('branchline.removeLicense', () => license.removeKey()),
    vscode.commands.registerCommand('branchline.buyPro', () => vscode.env.openExternal(vscode.Uri.parse(BUY_URL))),
    vscode.commands.registerCommand('branchline.refresh', () => GraphPanel.current?.refresh()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('branchline.showStatusBarItem')) updateStatus();
      if (e.affectsConfiguration('branchline')) scheduleRefresh();
    }),
  );
}

export function deactivate(): void {}
