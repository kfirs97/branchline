import * as vscode from 'vscode';
import { Git } from './git';

export const SCHEME = 'branchline';

/** A read-only URI for a file at a revision. An empty ref yields an empty document. */
export function revisionUri(repo: string, ref: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${path}`, query: JSON.stringify({ repo, ref }) });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { repo, ref } = JSON.parse(uri.query) as { repo: string; ref: string };
    if (!ref) return '';
    return new Git(repo).show(ref, uri.path.slice(1));
  }
}
