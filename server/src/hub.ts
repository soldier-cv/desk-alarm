import type { ServerMessage } from '../../shared/types.js';
import type { WebSocket } from 'ws';

interface Client {
  id: number;
  deviceId: string;
  socket: WebSocket;
}

let seq = 0;

class Hub {
  /** deviceId -> 该设备的连接集合。同一设备重连时留新踢旧 */
  private byDevice = new Map<string, Set<Client>>();

  add(deviceId: string, socket: WebSocket): Client {
    const client: Client = { id: ++seq, deviceId, socket };
    let set = this.byDevice.get(deviceId);
    if (!set) {
      set = new Set();
      this.byDevice.set(deviceId, set);
    }
    set.add(client);
    return client;
  }

  remove(client: Client) {
    const set = this.byDevice.get(client.deviceId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) this.byDevice.delete(client.deviceId);
  }

  /** 写成功返回 true。投递轮转器靠这个判断 delivered，所以不能静默失败 */
  send(client: Client, msg: ServerMessage): boolean {
    if (client.socket.readyState !== 1) return false; // 1 = OPEN
    try {
      client.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      // socket 已死，交给 close 事件清理
      return false;
    }
  }

  sendTo(deviceId: string, msg: ServerMessage): boolean {
    const set = this.byDevice.get(deviceId);
    if (!set) return false;
    let any = false;
    for (const c of set) any = this.send(c, msg) || any;
    return any;
  }

  sendToMany(deviceIds: string[], msg: ServerMessage) {
    for (const id of deviceIds) this.sendTo(id, msg);
  }

  /** 广播给所有在线设备。条目同步用这个，不区分推送范围 */
  broadcast(msg: ServerMessage) {
    for (const set of this.byDevice.values()) {
      for (const c of set) this.send(c, msg);
    }
  }

  isOnline(deviceId: string): boolean {
    const set = this.byDevice.get(deviceId);
    if (!set) return false;
    for (const c of set) {
      if (c.socket.readyState === 1) return true;
    }
    return false;
  }

  get connectionCount() {
    let n = 0;
    for (const set of this.byDevice.values()) n += set.size;
    return n;
  }
}

export const hub = new Hub();
