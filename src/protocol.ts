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
  dateFormat: 'relative' | 'absolute';
}

export type ToWebview =
  | { type: 'rows'; reset: boolean; state: ViewState; rows: Row[]; hasMore: boolean }
  | { type: 'details'; hash: string; details: CommitDetails | { hash: string; files: FileChange[] } }
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
  | { type: 'openDiff'; hash: string; file: FileChange }
  | { type: 'openFile'; path: string }
  | { type: 'commitAction'; action: CommitAction; hash: string; subject: string }
  | { type: 'refAction'; action: RefAction; ref: Ref };
