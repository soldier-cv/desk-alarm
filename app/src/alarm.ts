/**
 * 强提示升级阶梯：0 秒亮接管窗口，30 秒加抖动，5 分钟后重复。
 * 停止条件只有「用户处理了」或「别的设备处理了」。完整见 docs/requirements.md
 */
import { inQuietHours, loadConfig, shouldRing, type AckAction, type Entry, type Settings } from './api';

export interface AlarmCallbacks {
  /** 到点了，需要弹 Toast */
  onNotify: (entry: Entry, attempt: number) => void;
  /** 需要显示接管窗口（只有 strong 才会走到这） */
  onShow: (entry: Entry) => void;
  /** 升级到第 2 步，开始抖 */
  onEscalate: (entry: Entry) => void;
  /** 重复提醒一次 */
  onRepeat: (entry: Entry, attempt: number) => void;
  /** 处理完了，收起窗口 */
  onDismiss: (entry: Entry, reason: 'self' | 'elsewhere' | 'muted') => void;
}

interface Active {
  entry: Entry;
  startedAt: number;
  attempt: number;
  escalTimer: number | null;
  repeatTimer: number | null;
}

export class AlarmController {
  private active: Active | null = null;

  constructor(private cb: AlarmCallbacks) {}

  get current(): Entry | null {
    return this.active?.entry ?? null;
  }

  get isRinging(): boolean {
    return this.active !== null;
  }

  /**
   * 响铃。返回是否真的进了强提醒队列。
   * weak 的条目只弹通知就返回 false，由调用方走弱提示横幅
   */
  fire(entry: Entry): boolean {
    const settings = loadConfig().settings;
    this.cb.onNotify(entry, 1);

    if (!shouldRing(entry, settings)) {
      return false;
    }
    if (this.active && this.active.entry.id === entry.id) return true;
    if (this.active) this.clearTimers();

    this.active = {
      entry,
      startedAt: Date.now(),
      attempt: 1,
      escalTimer: null,
      repeatTimer: null,
    };

    this.cb.onShow(entry);
    this.scheduleEscalate(settings.escalateAfterSec);
    this.scheduleRepeat(settings.repeatEverySec * 1000);
    return true;
  }

  private scheduleEscalate(sec: number) {
    if (!this.active || sec <= 0) return;
    const entry = this.active.entry;
    this.active.escalTimer = window.setTimeout(() => {
      if (!this.active) return;
      this.cb.onEscalate(entry);
      // 升级之后改成每分钟一次，比第一次更密
      this.scheduleRepeat(60_000);
    }, sec * 1000);
  }

  private scheduleRepeat(ms: number) {
    if (!this.active || ms <= 0) return;
    const id = this.active.entry.id;
    this.active.repeatTimer = window.setTimeout(() => {
      if (!this.active || this.active.entry.id !== id) return;
      this.active.attempt += 1;
      this.cb.onRepeat(this.active.entry, this.active.attempt);
      this.scheduleRepeat(ms);
    }, ms);
  }

  /** 本机处理了。走 WS 让所有设备同时停铃 */
  acknowledge(action: AckAction, snoozeTo?: number) {
    if (!this.active) return null;
    const entry = this.active.entry;
    this.stop();
    this.cb.onDismiss(entry, 'self');
    return { entry, action, snoozeTo };
  }

  /** 别的设备处理了 */
  dismissedElsewhere() {
    if (!this.active) return;
    const entry = this.active.entry;
    this.stop();
    this.cb.onDismiss(entry, 'elsewhere');
  }

  stop() {
    this.clearTimers();
    this.active = null;
  }

  private clearTimers() {
    if (!this.active) return;
    if (this.active.escalTimer !== null) clearTimeout(this.active.escalTimer);
    if (this.active.repeatTimer !== null) clearTimeout(this.active.repeatTimer);
    this.active.escalTimer = null;
    this.active.repeatTimer = null;
  }
}

/* ---------------------------------------------------------- 弱提示队列 */

/**
 * weak 强度的提醒只出一条横幅，不抢注意力。
 * 同一时间最多留 3 条，多了就把最老的收掉，避免堆成一片
 */
const MAX_WEAK = 3;
const weak: Entry[] = [];

type WeakListener = (list: Entry[]) => void;
let weakListener: WeakListener | null = null;

export function onWeakChange(fn: WeakListener) {
  weakListener = fn;
  fn([...weak]);
}

export function pushWeak(entry: Entry) {
  if (weak.some((e) => e.id === entry.id)) return;
  weak.push(entry);
  while (weak.length > MAX_WEAK) weak.shift();
  weakListener?.([...weak]);
}

export function popWeak(entryId: string) {
  const i = weak.findIndex((e) => e.id === entryId);
  if (i < 0) return;
  weak.splice(i, 1);
  weakListener?.([...weak]);
}

export function listWeak(): Entry[] {
  return [...weak];
}

export function clearWeak() {
  weak.length = 0;
  weakListener?.([]);
}

/** 收掉某条弱提示。用户点了完成/推迟/忽略之后调它 */
export function dropWeakByEntry(entryId: string) {
  const hit = weak.some((e) => e.id === entryId);
  if (hit) popWeak(entryId);
}

export type { Settings, AckAction };
export { inQuietHours };
