import { execFile } from 'node:child_process';

const FIELD = '\x1f';
const RECORD = '\x1e';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly args: string[]) {
    super(message);
  }
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number; // unix seconds
  subject: string;
}

export type RefType = 'head' | 'remote' | 'tag' | 'stash';

export interface Ref {
  name: string;
  type: RefType;
  hash: string;
}

export interface FileChange {
  status: string; // A, M, D, R, C, T, U
  path: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

export interface CommitDetails extends Commit {
  body: string;
  committer: string;
  committerEmail: string;
  commitDate: number;
  files: FileChange[];
}

export interface RepoState {
  head: string | null; // commit hash, null for an empty repo
  branch: string | null; // null when detached
  refs: Ref[];
  dirty: number; // number of changed paths in the working tree / index
}

export class Git {
  constructor(readonly cwd: string, private readonly gitPath = 'git') {}

  run(args: string[], opts: { input?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gitPath,
        args,
        { cwd: this.cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr || err.message).trim().split('\n').filter(Boolean).pop() ?? err.message;
            reject(new GitError(msg, stderr, args));
          } else {
            resolve(stdout);
          }
        },
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  static async topLevel(dir: string, gitPath?: string): Promise<string | null> {
    try {
      return (await new Git(dir, gitPath).run(['rev-parse', '--show-toplevel'])).trim();
    } catch {
      return null;
    }
  }

  async log(opts: { skip: number; count: number; allRefs: boolean; search?: string }): Promise<Commit[]> {
    const args = [
      'log',
      '--date-order',
      `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${RECORD}`,
      `--skip=${opts.skip}`,
      `-n${opts.count}`,
    ];
    if (opts.search) args.push('-i', '--fixed-strings', `--grep=${opts.search}`);
    args.push(...(opts.allRefs ? ['--branches', '--remotes', '--tags', 'HEAD'] : ['HEAD']));
    args.push('--');
    let out: string;
    try {
      out = await this.run(args);
    } catch (e) {
      if (e instanceof GitError && /does not have any commits|unknown revision|bad (default )?revision/.test(e.stderr)) return [];
      throw e;
    }
    return parseLog(out);
  }

  async state(): Promise<RepoState> {
    const [head, branch, refs, status] = await Promise.all([
      this.run(['rev-parse', '--verify', '-q', 'HEAD']).then(s => s.trim() || null, () => null),
      this.run(['symbolic-ref', '--short', '-q', 'HEAD']).then(s => s.trim() || null, () => null),
      this.run(['for-each-ref', `--format=%(objectname)${FIELD}%(*objectname)${FIELD}%(refname)`]).then(parseRefs),
      this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    return { head, branch, refs, dirty: countStatusEntries(status) };
  }

  async details(hash: string): Promise<CommitDetails> {
    const out = await this.run([
      'show', '-s',
      `--format=%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%cn${FIELD}%ce${FIELD}%ct${FIELD}%s${FIELD}%b`,
      hash,
    ]);
    const [h, p, an, ae, at, cn, ce, ct, subject, body] = out.split(FIELD);
    const parents = p ? p.split(' ') : [];
    return {
      hash: h, parents, author: an, email: ae, date: Number(at), subject,
      body: (body ?? '').trimEnd(), committer: cn, committerEmail: ce, commitDate: Number(ct),
      files: await this.changes(parents[0] ?? null, hash),
    };
  }

  /** Files changed between two commits. `from` null means the commit is a root commit. `to` null means the working tree. */
  async changes(from: string | null, to: string | null): Promise<FileChange[]> {
    const range = to === null ? [from ?? 'HEAD'] : from === null ? ['--root', to] : [from, to];
    const base = to === null ? ['diff', '-M'] : ['diff-tree', '-r', '--no-commit-id', '-M'];
    const [names, nums] = await Promise.all([
      this.run([...base, '--name-status', '-z', ...range, '--']),
      this.run([...base, '--numstat', '-z', ...range, '--']),
    ]);
    const files = parseNameStatus(names);
    const stats = parseNumstat(nums);
    for (const f of files) {
      const s = stats.get(f.path);
      if (s) Object.assign(f, s);
    }
    if (to === null) {
      const untracked = await this.run(['ls-files', '--others', '--exclude-standard', '-z']);
      for (const path of untracked.split('\0').filter(Boolean)) files.push({ status: 'U', path });
    }
    return files;
  }

  /** File contents at a revision, or empty when the path does not exist there. */
  async show(ref: string, path: string): Promise<string> {
    try {
      return await this.run(['show', `${ref}:${path}`]);
    } catch {
      return '';
    }
  }
}

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const raw of out.split(RECORD)) {
    const rec = raw.replace(/^\n/, '');
    if (!rec) continue;
    const [hash, parents, author, email, date, subject] = rec.split(FIELD);
    commits.push({ hash, parents: parents ? parents.split(' ') : [], author, email, date: Number(date), subject: subject ?? '' });
  }
  return commits;
}

export function parseRefs(out: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [obj, peeled, full] = line.split(FIELD);
    const hash = peeled || obj;
    if (full.startsWith('refs/heads/')) refs.push({ type: 'head', name: full.slice(11), hash });
    else if (full.startsWith('refs/remotes/')) {
      if (!full.endsWith('/HEAD')) refs.push({ type: 'remote', name: full.slice(13), hash });
    } else if (full.startsWith('refs/tags/')) refs.push({ type: 'tag', name: full.slice(10), hash });
    else if (full === 'refs/stash') refs.push({ type: 'stash', name: 'stash', hash });
  }
  return refs;
}

/** Counts entries in `git status --porcelain=v1 -z` output; renames/copies carry an extra old-path field. */
export function countStatusEntries(out: string): number {
  const parts = out.split('\0');
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].length < 4) continue;
    count++;
    if (parts[i][0] === 'R' || parts[i][0] === 'C') i++;
  }
  return count;
}

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, oldPath: parts[i++], path: parts[i++] });
    } else {
      files.push({ status: letter, path: parts[i++] });
    }
  }
  return files;
}

export function parseNumstat(out: string): Map<string, { additions?: number; deletions?: number }> {
  // -z numstat: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0"
  const parts = out.split('\0');
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i].replace(/^\n/, ''));
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      i++; // old path
      path = parts[++i];
    }
    const num = (s: string) => (s === '-' ? undefined : Number(s));
    stats.set(path, { additions: num(m[1]), deletions: num(m[2]) });
  }
  return stats;
}
