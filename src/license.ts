import * as vscode from 'vscode';
import { BUY_URL, verifyWithGumroad } from './licenseVerify';

const KEY_SECRET = 'branchline.licenseKey';
const CHECKED_STATE = 'branchline.licenseCheckedAt';
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a previously valid key keeps working while Gumroad can't be reached. */
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export class License {
  private pro = false;
  private readonly changed = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get isPro(): boolean {
    return this.pro;
  }

  /** Restores the stored key, re-verifying it in the background when the last check is stale. */
  async init(): Promise<void> {
    const key = await this.context.secrets.get(KEY_SECRET);
    if (!key) return;
    const checkedAt = this.context.globalState.get<number>(CHECKED_STATE, 0);
    this.set(Date.now() - checkedAt < OFFLINE_GRACE_MS);
    if (Date.now() - checkedAt > RECHECK_MS) void this.recheck(key);
  }

  private async recheck(key: string): Promise<void> {
    const result = await verifyWithGumroad(key);
    if (result.ok) {
      await this.context.globalState.update(CHECKED_STATE, Date.now());
      this.set(true);
    } else if (!result.network) {
      await this.context.secrets.delete(KEY_SECRET);
      this.set(false);
      void vscode.window.showWarningMessage(`Branchline Pro was deactivated: ${result.reason}`);
    }
  }

  async enterKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'Activate Branchline Pro',
      prompt: 'Paste the license key from your Gumroad receipt',
      ignoreFocusOut: true,
      validateInput: v => (v.trim() ? null : 'License key is required'),
    });
    if (!key) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Verifying license…' },
      () => verifyWithGumroad(key),
    );
    if (!result.ok) {
      void vscode.window.showErrorMessage(result.reason);
      return;
    }
    await this.context.secrets.store(KEY_SECRET, key.trim());
    await this.context.globalState.update(CHECKED_STATE, Date.now());
    this.set(true);
    void vscode.window.showInformationMessage('Branchline Pro activated. Thank you for supporting Branchline!');
  }

  async removeKey(): Promise<void> {
    await this.context.secrets.delete(KEY_SECRET);
    await this.context.globalState.update(CHECKED_STATE, undefined);
    this.set(false);
    void vscode.window.showInformationMessage('Branchline Pro license removed from this machine.');
  }

  /** Shows the upgrade prompt for a Pro-only feature. Returns true when Pro is active. */
  async require(feature: string): Promise<boolean> {
    if (this.pro) return true;
    const pick = await vscode.window.showInformationMessage(
      `${feature} is a Branchline Pro feature.`,
      { detail: 'Branchline Pro is a one-time purchase. One license unlocks Pro in all Branchline extensions: Branchline, TODO Lens, Snapline and Docline.', modal: true },
      'Get Pro',
      'Enter License Key',
    );
    if (pick === 'Get Pro') void vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
    if (pick === 'Enter License Key') await this.enterKey();
    return this.pro;
  }

  private set(pro: boolean): void {
    if (pro === this.pro) return;
    this.pro = pro;
    this.changed.fire(pro);
  }
}
