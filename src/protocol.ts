import type { CommitDetails, FileChange, Ref } from './git';
import type { RowLayout } from './graph';

/** Hash used for the synthetic "Uncommitted changes" row. */
export const WORKING_TREE = '*';

export interface Row {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: Ref[];
  layout: RowLayout;
}

export interface ViewState {
  repos: string[];
  repo: string | null;
  branch: string | null;
  head: string | null;
  allRefs: boolean;
  search: string;
  /** Repo-relative path when showing a file's history. */
  path: string | null;
  pro: boolean;
  dateFormat: 'relative' | 'absolute';
}

/** Files changed between two commits, shown when comparing (`from` is the older side). */
export interface Comparison {
  from: string;
  to: string;
  files: FileChange[];
}

export type ToWebview =
  | { type: 'rows'; reset: boolean; state: ViewState; rows: Row[]; hasMore: boolean }
  | { type: 'details'; hash: string; details: CommitDetails | { hash: string; files: FileChange[] } }
  | { type: 'comparison'; comparison: Comparison }
  | { type: 'dirty'; count: number }
  | { type: 'error'; message: string }
  | { type: 'loading' };

export type CommitAction =
  | 'checkout' | 'createBranch' | 'createTag' | 'cherryPick' | 'revert'
  | 'resetSoft' | 'resetMixed' | 'resetHard' | 'copyHash' | 'copySubject';

export type RefAction =
  | 'checkout' | 'merge' | 'rebase' | 'rename' | 'delete' | 'push' | 'copyName';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'loadMore' }
  | { type: 'refresh' }
  | { type: 'fetch' }
  | { type: 'selectRepo'; repo: string }
  | { type: 'setFilter'; allRefs: boolean; search: string }
  | { type: 'details'; hash: string }
  | { type: 'openDiff'; hash: string; file: FileChange; base?: string }
  | { type: 'compare'; from: string; to: string }
  | { type: 'clearPath' }
  | { type: 'getPro' }
  | { type: 'openFile'; path: string }
  | { type: 'commitAction'; action: CommitAction; hash: string; subject: string }
  | { type: 'refAction'; action: RefAction; ref: Ref };
