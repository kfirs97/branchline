import * as vscode from 'vscode';
import { BUY_URL, verifyWithGumroad } from './licenseVerify';
import { TRIAL_DAYS, trialStatus } from './trial';

const KEY_SECRET = 'branchline.licenseKey';
const CHECKED_STATE = 'branchline.licenseCheckedAt';
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a previously valid key keeps working while Gumroad can't be reached. */
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_STARTED = 'branchline.trialStartedAt';
const TRIAL_END_SHOWN = 'branchline.trialEndShown';

/** What this extension's Pro trial unlocks, for the trial start/end messages. */
export interface TrialInfo {
  product: string;
  /** Short list used in sentences, e.g. "comparing any two commits and file history". */
  features: string;
  /** How to try the features, shown when the trial starts. */
  howTo: string;
}

export class License implements vscode.Disposable {
  private pro = false;
  private trial = false;
  private trialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changed = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly trialInfo?: TrialInfo,
  ) {}

  /** True with a paid license or during the free trial. */
  get isPro(): boolean {
    return this.pro || this.trial;
  }

  /** True while Pro features are unlocked only by the free trial. */
  get isTrial(): boolean {
    return this.trial && !this.pro;
  }

  /** Restores the stored key (re-verifying it in the background when stale), then starts or resumes the trial. */
  async init(): Promise<void> {
    const key = await this.context.secrets.get(KEY_SECRET);
    if (key) {
      const checkedAt = this.context.globalState.get<number>(CHECKED_STATE, 0);
      this.set(Date.now() - checkedAt < OFFLINE_GRACE_MS);
      if (Date.now() - checkedAt > RECHECK_MS) void this.recheck(key);
    }
    await this.initTrial();
  }

  /** Every user gets Pro free for the first days, so they can see what it adds before deciding. */
  private async initTrial(): Promise<void> {
    if (!this.trialInfo) return;
    const state = this.context.globalState;
    let started = state.get<number>(TRIAL_STARTED);
    const isNew = started === undefined;
    if (started === undefined) {
      started = Date.now();
      await state.update(TRIAL_STARTED, started);
    }
    const status = trialStatus(started);
    if (!status.active) return this.endTrial();
    this.setTrial(true);
    this.trialTimer = setTimeout(() => void this.endTrial(), status.msLeft);
    if (isNew && !this.pro) {
      void vscode.window.showInformationMessage(
        `${this.trialInfo.product} Pro is unlocked free for ${TRIAL_DAYS} days — no signup: ${this.trialInfo.features}. ${this.trialInfo.howTo}`,
      );
    }
  }

  private async endTrial(): Promise<void> {
    this.setTrial(false);
    if (!this.trialInfo || this.pro || this.context.globalState.get(TRIAL_END_SHOWN)) return;
    await this.context.globalState.update(TRIAL_END_SHOWN, true);
    const pick = await vscode.window.showInformationMessage(
      `Your ${this.trialInfo.product} Pro trial has ended. Keep ${this.trialInfo.features} with a one-time $9 license (also unlocks Pro in all Branchline extensions).`,
      'Get Pro',
      'Enter License Key',
    );
    if (pick === 'Get Pro') void vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
    if (pick === 'Enter License Key') await this.enterKey();
  }

  dispose(): void {
    clearTimeout(this.trialTimer);
    this.changed.dispose();
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
    if (this.isPro) return true;
    const pick = await vscode.window.showInformationMessage(
      `${feature} is a Branchline Pro feature.`,
      { detail: 'Branchline Pro is a one-time purchase. One license unlocks Pro in all Branchline extensions: Branchline, TODO Lens, Snapline and Docline.', modal: true },
      'Get Pro',
      'Enter License Key',
    );
    if (pick === 'Get Pro') void vscode.env.openExternal(vscode.Uri.parse(BUY_URL));
    if (pick === 'Enter License Key') await this.enterKey();
    return this.isPro;
  }

  private set(pro: boolean): void {
    const before = this.isPro;
    this.pro = pro;
    if (this.isPro !== before) this.changed.fire(this.isPro);
  }

  private setTrial(trial: boolean): void {
    const before = this.isPro;
    this.trial = trial;
    if (this.isPro !== before) this.changed.fire(this.isPro);
  }
}
