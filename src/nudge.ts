import * as vscode from 'vscode';
import { License } from './license';
import { BUY_URL } from './licenseVerify';

const FIRST_USE = 'branchline.firstUse';
const OPENS = 'branchline.graphOpens';
const DONE = 'branchline.nudgeDone';
const MIN_DAYS = 7;
const MIN_OPENS = 5;

/** Review page for the store this editor installs from (Open VSX for Cursor, Windsurf, VSCodium, …). */
function reviewUrl(): string {
  return /visual studio code/i.test(vscode.env.appName)
    ? 'https://marketplace.visualstudio.com/items?itemName=branchline.branchline&ssr=false#review-details'
    : 'https://open-vsx.org/extension/branchline/branchline/reviews';
}

/**
 * Called whenever the graph is opened. After a week of real use, asks once for a rating
 * (and mentions Pro to free users). Never shown again after any answer.
 */
export async function recordGraphOpen(context: vscode.ExtensionContext, license: License): Promise<void> {
  const state = context.globalState;
  if (state.get(DONE)) return;
  const now = Date.now();
  const first = state.get<number>(FIRST_USE) ?? (await state.update(FIRST_USE, now), now);
  const opens = state.get<number>(OPENS, 0) + 1;
  await state.update(OPENS, opens);
  if (opens < MIN_OPENS || now - first < MIN_DAYS * 86_400_000) return;

  await state.update(DONE, true);
  const actions = license.isPro ? ['Rate Branchline', 'No Thanks'] : ['Rate Branchline', 'Get Pro', 'No Thanks'];
  const pick = await vscode.window.showInformationMessage(
    'Enjoying Branchline? A quick rating helps other developers find it.',
    ...actions,
  );
  if (pick === 'Rate Branchline') void vscode.env.openExternal(vscode.Uri.parse(reviewUrl()));
  if (pick === 'Get Pro') void vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
}
