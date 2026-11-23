/**
 * 跟进控制器。等级来自服务端 nudge：L1 静默入列表、L2 通知、L3 横幅、L4 接管、L5 归档。
 * 停止条件：用户处理、别的设备处理、等级降级；静音时段把 L4 压回 L2。
 */
import {
  inQuietHours, loadConfig,
  type FollowupAction, type NudgeChannel, type NudgeLevel, type Pursuit,
} from './api';

export type FollowupStopReason = 'self' | 'elsewhere' | 'lowered' | 'aged';

export interface FollowupCallbacks {
  onSilent: (pursuit: Pursuit, level: NudgeLevel) => void;
  onNotify: (pursuit: Pursuit, level: NudgeLevel, reason: string, attempt: number) => void;
  onBanner: (pursuit: Pursuit, level: NudgeLevel, reason: string) => void;
  onTakeover: (pursuit: Pursuit, level: NudgeLevel, reason: string) => void;
  onArchive: (pursuit: Pursuit, reason: string) => void;
  onStop: (pursuit: Pursuit, reason: FollowupStopReason) => void;
}

interface Active {
  pursuit: Pursuit;
  level: NudgeLevel;
  reason: string;
  channel: NudgeChannel;
  attempt: number;
  timer: number | null;
}

/** 重复间隔先密后疏；不设次数上限，停由用户动作或等级升级决定 */
const REPEAT_LADDER: Record<NudgeLevel, number[]> = {
  1: [],
  2: [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000],
  3: [2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000],
  4: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
  5: [],
};

export class FollowupController {
  private active: Active | null = null;

  constructor(private cb: FollowupCallbacks) {}

  get current(): Pursuit | null {
    return this.active?.pursuit ?? null;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get level(): NudgeLevel | null {
    return this.active?.level ?? null;
  }

  /**
   * 收到 nudge。重复同一项同级不重入；更高级别覆盖旧状态。
   * 返回是否真正触发了表现，让调用方决定要不要刷新界面
   */
  fire(pursuit: Pursuit, level: NudgeLevel, reason: string, channel: NudgeChannel = 'in_app'): boolean {
    const s = loadConfig().settings;
    // 静音时段的 L4 降级，服务端也会算；这里再兜一层，避免广播顺序导致闪一下接管窗
    const effective: NudgeLevel = level >= 4 && inQuietHours(s) ? 2 : level;

    if (this.active?.pursuit.id === pursuit.id) {
      if (effective <= this.active.level) return false;
      this.stop();
    } else if (this.active) {
      this.stop();
    }

    this.active = {
      pursuit, level: effective, reason, channel, attempt: 1, timer: null,
    };

    switch (effective) {
      case 1:
        this.cb.onSilent(pursuit, 1);
        break;
      case 2:
        this.cb.onNotify(pursuit, 2, reason, 1);
        this.scheduleRepeat();
        break;
      case 3:
        this.cb.onNotify(pursuit, 3, reason, 1);
        this.cb.onBanner(pursuit, 3, reason);
        this.scheduleRepeat();
        break;
      case 4:
        this.cb.onTakeover(pursuit, 4, reason);
        this.scheduleRepeat();
        break;
      case 5:
        this.cb.onArchive(pursuit, reason);
        this.stop();
        break;
    }
    return true;
  }

  private scheduleRepeat() {
    const a = this.active;
    if (!a) return;
    const ladder = REPEAT_LADDER[a.level];
    if (!ladder.length) return;
    const ms = ladder[Math.min(a.attempt - 1, ladder.length - 1)];
    a.timer = window.setTimeout(() => {
      const cur = this.active;
      if (!cur || cur.pursuit.id !== a.pursuit.id) return;
      // 静音时段只顺延，不消耗次数；静音结束后接着原来的节奏提醒
      if (inQuietHours(loadConfig().settings)) {
        this.scheduleRepeat();
        return;
      }
      cur.attempt += 1;
      if (cur.level === 2 || cur.level === 3) {
        this.cb.onNotify(cur.pursuit, cur.level, cur.reason, cur.attempt);
      } else if (cur.level === 4) {
        this.cb.onTakeover(cur.pursuit, 4, cur.reason);
      }
      this.scheduleRepeat();
    }, ms);
  }

  /** 用户在本机处理了（跟进动作） */
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

  /** 等级降级：收起高等级表现，退回低等级 */
  downgrade(level: NudgeLevel) {
    const a = this.active;
    if (!a || level >= a.level) return;
    const p = a.pursuit, reason = a.reason;
    this.stop();
    if (level === 3) this.cb.onBanner(p, 3, reason);
    else if (level === 2) this.cb.onNotify(p, 2, reason, 1);
    else this.cb.onSilent(p, 1);
    this.cb.onStop(p, 'lowered');
  }

  stop() {
    const a = this.active;
    if (a?.timer !== null && a?.timer !== undefined) clearTimeout(a.timer);
    this.active = null;
  }
}

/* ---------------------------------------------------------- 横幅队列 */

/** L3 横幅替代旧的 weak 队列：最多 3 条，多了收掉最老的，避免堆成噪声 */
export interface Banner {
  pursuit: Pursuit;
  reason: string;
  level: NudgeLevel;
}

const MAX_BANNERS = 3;
const banners: Banner[] = [];

type BannerListener = (list: Banner[]) => void;
let bannerListener: BannerListener | null = null;

export function onBannerChange(fn: BannerListener) {
  bannerListener = fn;
  fn([...banners]);
}

export function pushBanner(pursuit: Pursuit, reason: string, level: NudgeLevel) {
  if (banners.some((b) => b.pursuit.id === pursuit.id)) return;
  banners.push({ pursuit, reason, level });
  while (banners.length > MAX_BANNERS) banners.shift();
  bannerListener?.([...banners]);
}

export function dropBannerByPursuit(pursuitId: string) {
  const i = banners.findIndex((b) => b.pursuit.id === pursuitId);
  if (i < 0) return;
  banners.splice(i, 1);
  bannerListener?.([...banners]);
}

export function listBanners(): Banner[] {
  return [...banners];
}

export function clearBanners() {
  banners.length = 0;
  bannerListener?.([]);
}
