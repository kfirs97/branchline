import * as vscode from 'vscode';
import { Git, GitError, Ref, RepoState } from './git';
import { CommitAction, RefAction } from './protocol';

const validRefName = (git: Git) => async (name: string) => {
  if (!name.trim()) return 'Name is required';
  try {
    await git.run(['check-ref-format', '--branch', name]);
    return null;
  } catch {
    return 'Not a valid git ref name';
  }
};

function warn(message: string): false {
  void vscode.window.showWarningMessage(message);
  return false;
}

async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

/** Runs a git command, reporting failures to the user. Returns true when the repo changed. */
async function exec(git: Git, args: string[], title: string): Promise<boolean> {
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => git.run(args));
    return true;
  } catch (e) {
    const msg = e instanceof GitError ? e.message : String(e);
    void vscode.window.showErrorMessage(`${title} failed: ${msg}`);
    // Conflicts leave the repo in a changed state (e.g. mid-merge), so still refresh.
    return /conflict/i.test(e instanceof GitError ? e.stderr : '');
  }
}

export async function runCommitAction(git: Git, action: CommitAction, hash: string, subject: string): Promise<boolean> {
  const short = hash.slice(0, 7);
  switch (action) {
    case 'copyHash':
      await vscode.env.clipboard.writeText(hash);
      return false;
    case 'copySubject':
      await vscode.env.clipboard.writeText(subject);
      return false;
    case 'checkout':
      if (!(await confirm(`Check out commit ${short}?`, 'This puts the repository in a detached HEAD state.', 'Checkout'))) return false;
      return exec(git, ['checkout', '-q', hash], `Checkout ${short}`);
    case 'createBranch': {
      const name = await vscode.window.showInputBox({ title: `Create branch at ${short}`, prompt: 'Branch name', validateInput: validRefName(git) });
      if (!name) return false;
      const pick = await vscode.window.showQuickPick(['Create and check out', 'Create only'], { title: `Branch "${name}"` });
      if (!pick) return false;
      return exec(git, pick === 'Create only' ? ['branch', name, hash] : ['checkout', '-q', '-b', name, hash], `Create branch ${name}`);
    }
    case 'createTag': {
      const name = await vscode.window.showInputBox({ title: `Create tag at ${short}`, prompt: 'Tag name', validateInput: validRefName(git) });
      if (!name) return false;
      const message = await vscode.window.showInputBox({ title: `Tag "${name}"`, prompt: 'Message (leave empty for a lightweight tag)' });
      if (message === undefined) return false;
      return exec(git, message ? ['tag', '-a', name, '-m', message, hash] : ['tag', name, hash], `Create tag ${name}`);
    }
    case 'cherryPick':
      if (!(await confirm(`Cherry-pick ${short} onto the current branch?`, subject, 'Cherry-pick'))) return false;
      return exec(git, ['cherry-pick', hash], `Cherry-pick ${short}`);
    case 'revert':
      if (!(await confirm(`Revert ${short}?`, `Creates a new commit that undoes: ${subject}`, 'Revert'))) return false;
      return exec(git, ['revert', '--no-edit', hash], `Revert ${short}`);
    case 'resetSoft':
    case 'resetMixed':
    case 'resetHard': {
      const mode = action.slice(5).toLowerCase();
      const detail =
        mode === 'hard'
          ? 'All uncommitted changes will be permanently discarded, and commits after this one will be removed from the current branch.'
          : mode === 'mixed'
            ? 'Commits after this one are removed from the branch; their changes are kept as unstaged changes.'
            : 'Commits after this one are removed from the branch; their changes are kept staged.';
      if (!(await confirm(`Reset current branch to ${short} (--${mode})?`, detail, `Reset (--${mode})`))) return false;
      return exec(git, ['reset', `--${mode}`, hash], `Reset --${mode}`);
    }
  }
}

export async function runRefAction(git: Git, action: RefAction, ref: Ref, state: RepoState): Promise<boolean> {
  const current = state.branch;
  switch (action) {
    case 'copyName':
      await vscode.env.clipboard.writeText(ref.name);
      return false;
    case 'checkout': {
      if (ref.type === 'head') return exec(git, ['checkout', '-q', ref.name], `Checkout ${ref.name}`);
      if (ref.type === 'remote') {
        const local = ref.name.slice(ref.name.indexOf('/') + 1);
        if (state.refs.some(r => r.type === 'head' && r.name === local)) {
          return exec(git, ['checkout', '-q', local], `Checkout ${local}`);
        }
        return exec(git, ['checkout', '-q', '--track', ref.name], `Checkout ${local}`);
      }
      return exec(git, ['checkout', '-q', ref.name], `Checkout ${ref.name}`);
    }
    case 'merge': {
      if (!current) return warn('Check out a branch before merging.');
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Merge', args: [] as string[] },
          { label: 'Merge (always create a merge commit)', args: ['--no-ff'] },
          { label: 'Squash merge', args: ['--squash'] },
        ],
        { title: `Merge ${ref.name} into ${current}` },
      );
      if (!pick) return false;
      return exec(git, ['merge', ...pick.args, ref.name], `Merge ${ref.name}`);
    }
    case 'rebase':
      if (!current) return warn('Check out a branch before rebasing.');
      if (!(await confirm(`Rebase ${current} onto ${ref.name}?`, 'Commits on the current branch will be rewritten.', 'Rebase'))) return false;
      return exec(git, ['rebase', ref.name], `Rebase onto ${ref.name}`);
    case 'rename': {
      if (ref.type !== 'head') return false;
      const name = await vscode.window.showInputBox({ title: `Rename ${ref.name}`, value: ref.name, validateInput: validRefName(git) });
      if (!name || name === ref.name) return false;
      return exec(git, ['branch', '-m', ref.name, name], `Rename ${ref.name}`);
    }
    case 'push':
      if (ref.type === 'tag') return exec(git, ['push', 'origin', `refs/tags/${ref.name}`], `Push tag ${ref.name}`);
      if (ref.type !== 'head') return false;
      return exec(git, ['push', '-u', 'origin', ref.name], `Push ${ref.name}`);
    case 'delete': {
      if (ref.type === 'head') {
        if (ref.name === current) return warn('Cannot delete the checked-out branch.');
        if (!(await confirm(`Delete branch ${ref.name}?`, 'The branch ref is removed locally.', 'Delete'))) return false;
        try {
          await git.run(['branch', '-d', ref.name]);
          return true;
        } catch (e) {
          if (!(e instanceof GitError && /not fully merged/.test(e.stderr))) throw e;
          if (!(await confirm(`${ref.name} is not fully merged.`, 'Force delete it? Its unmerged commits may become unreachable.', 'Force delete'))) return false;
          return exec(git, ['branch', '-D', ref.name], `Delete ${ref.name}`);
        }
      }
      if (ref.type === 'remote') {
        const slash = ref.name.indexOf('/');
        const [remote, branch] = [ref.name.slice(0, slash), ref.name.slice(slash + 1)];
        if (!(await confirm(`Delete ${branch} on remote ${remote}?`, 'This deletes the branch on the server for everyone.', 'Delete remote branch'))) return false;
        return exec(git, ['push', remote, '--delete', branch], `Delete ${ref.name}`);
      }
      if (ref.type === 'tag') {
        if (!(await confirm(`Delete tag ${ref.name}?`, 'The tag is removed locally only.', 'Delete'))) return false;
        return exec(git, ['tag', '-d', ref.name], `Delete tag ${ref.name}`);
      }
      return false;
    }
  }
}
