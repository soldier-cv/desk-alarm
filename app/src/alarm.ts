/**
 * 跟进控制器。强弱二值：弱提醒发通知、强提醒弹接管窗。
 * 逾期复催节奏统一由服务端权威驱动，客户端不再维护易断的内存定时器。
 */
import {
  inQuietHours, loadConfig, strengthOfLevel,
  type FollowupAction, type NudgeChannel, type NudgeLevel, type Pursuit,
} from './api';

export type FollowupStopReason = 'self' | 'elsewhere';

export interface FollowupCallbacks {
  onNotify: (pursuit: Pursuit, reason: string, attempt: number) => void;
  onTakeover: (pursuit: Pursuit, reason: string) => void;
  onStop: (pursuit: Pursuit, reason: FollowupStopReason) => void;
}

interface Active {
  pursuit: Pursuit;
  reason: string;
  channel: NudgeChannel;
  attempt: number;
}

export class FollowupController {
  private active: Active | null = null;

  constructor(private cb: FollowupCallbacks) {}

  get current(): Pursuit | null {
    return this.active?.pursuit ?? null;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /** 收到服务端 nudge。允许同一条逾期复催再次提醒，静音时段自动跳过 */
  fire(pursuit: Pursuit, level: NudgeLevel, reason: string, channel: NudgeChannel = 'in_app'): boolean {
    if (inQuietHours(loadConfig().settings)) return false;
    const same = this.active?.pursuit.id === pursuit.id;
    const attempt = same ? (this.active!.attempt + 1) : 1;
    this.active = { pursuit, reason, channel, attempt };

    if (strengthOfLevel(level) === 'strong') {
      this.cb.onTakeover(pursuit, reason);
    } else {
      this.cb.onNotify(pursuit, reason, attempt);
    }
    return true;
  }

  acknowledge(action: FollowupAction): { pursuitId: string; action: FollowupAction } | null {
    const a = this.active;
    if (!a) return null;
    const result = { pursuitId: a.pursuit.id, action };
    this.active = null;
    this.cb.onStop(a.pursuit, 'self');
    return result;
  }

  dismissedElsewhere(pursuitId?: string) {
    const a = this.active;
    if (!a || (pursuitId && a.pursuit.id !== pursuitId)) return;
    this.active = null;
    this.cb.onStop(a.pursuit, 'elsewhere');
  }

  stop() {
    this.active = null;
  }
}
