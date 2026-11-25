/**
 * 跟进控制器。强弱二值：弱提醒发通知并按节奏重复，强提醒由接管窗承载。
 * 服务端是唯一的到点判定者，这里只负责表现和本地重复节奏。
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
  timer: number | null;
}

/** 弱提醒：1/10/30/60 分钟后改为每 120 分钟一次；强提醒不本地重复，窗关不掉 */
const WEAK_REPEAT: number[] = [
  60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 120 * 60_000,
];

export class FollowupController {
  private active: Active | null = null;

  constructor(private cb: FollowupCallbacks) {}

  get current(): Pursuit | null {
    return this.active?.pursuit ?? null;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /** 收到 nudge。同一条不重入，新的强势提醒覆盖旧状态。返回是否真正触发了表现 */
  fire(pursuit: Pursuit, level: NudgeLevel, reason: string, channel: NudgeChannel = 'in_app'): boolean {
    if (this.active?.pursuit.id === pursuit.id) return false;
    if (this.active) this.stop();

    this.active = { pursuit, reason, channel, attempt: 1, timer: null };
    if (strengthOfLevel(level) === 'strong') {
      this.cb.onTakeover(pursuit, reason);
    } else {
      this.cb.onNotify(pursuit, reason, 1);
      this.scheduleRepeat();
    }
    return true;
  }

  private scheduleRepeat() {
    const a = this.active;
    if (!a) return;
    const ms = WEAK_REPEAT[Math.min(a.attempt - 1, WEAK_REPEAT.length - 1)];
    a.timer = window.setTimeout(() => {
      const cur = this.active;
      if (!cur || cur.pursuit.id !== a.pursuit.id) return;
      // 静音时段只顺延，不消耗次数
      if (inQuietHours(loadConfig().settings)) {
        this.scheduleRepeat();
        return;
      }
      cur.attempt += 1;
      this.cb.onNotify(cur.pursuit, cur.reason, cur.attempt);
      this.scheduleRepeat();
    }, ms);
  }

  /** 用户在本机处理了 */
  acknowledge(action: FollowupAction): { pursuitId: string; action: FollowupAction } | null {
    const a = this.active;
    if (!a) return null;
    const result = { pursuitId: a.pursuit.id, action };
    this.stop();
    this.cb.onStop(a.pursuit, 'self');
    return result;
  }

  /** 别的设备处理了 */
  dismissedElsewhere(pursuitId?: string) {
    const a = this.active;
    if (!a || (pursuitId && a.pursuit.id !== pursuitId)) return;
    this.stop();
    this.cb.onStop(a.pursuit, 'elsewhere');
  }

  stop() {
    const a = this.active;
    if (a?.timer !== null && a?.timer !== undefined) clearTimeout(a.timer);
    this.active = null;
  }
}
