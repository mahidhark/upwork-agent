/** Alerting. Email first, but the channel is an adapter so more can follow. */

export type AlertKey =
  /** The Upwork authorization no longer works — the agent is blind until reconnected. */
  | 'auth_revoked'
  /** Connects balance has fallen below the configured floor. */
  | 'connects_low';

export type Severity = 'critical' | 'warning';

export interface Alert {
  key: AlertKey;
  severity: Severity;
  subject: string;
  /** Plain text. What happened, why it matters, what to do. */
  body: string;
  /**
   * Do not re-send this alert within this many minutes. An alert that fires on
   * every poll is an alert the operator learns to ignore.
   */
  throttleMinutes: number;
}

export interface AlertChannel {
  readonly name: string;
  configured(): boolean;
  send(alert: Alert): Promise<void>;
}
