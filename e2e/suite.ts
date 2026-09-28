import * as vscode from 'vscode';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('branchline.branchline');
  assert.ok(ext, 'extension is installed');
  await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('branchline.show'));

  await vscode.commands.executeCommand('branchline.show');
  await sleep(1500);
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.ok(tab?.input instanceof vscode.TabInputWebview, 'graph panel is the active tab');
  assert.match(tab.label, /^Git Graph: branchline-e2e-/);

  const repo = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const uri = vscode.Uri.from({ scheme: 'branchline', path: '/a.txt', query: JSON.stringify({ repo, ref: 'HEAD' }) });
  const doc = await vscode.workspace.openTextDocument(uri);
  assert.equal(doc.getText(), 'hello\n', 'content provider serves file at revision');

  await vscode.commands.executeCommand('branchline.refresh');
  console.log('E2E: all checks passed');
}
