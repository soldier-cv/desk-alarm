import type { ServerMessage } from '../../shared/types.js';
import type { WebSocket } from 'ws';

interface Client {
  id: number;
  userId: string;
  deviceId: string;
  socket: WebSocket;
}

let seq = 0;

class Hub {
  /** userId -> deviceId -> 连接集合。同设备重连时留新踢旧由上层处理 */
  private byUser = new Map<string, Map<string, Set<Client>>>();

  add(userId: string, deviceId: string, socket: WebSocket): Client {
    const client: Client = { id: ++seq, userId, deviceId, socket };
    let devices = this.byUser.get(userId);
    if (!devices) {
      devices = new Map();
      this.byUser.set(userId, devices);
    }
    let set = devices.get(deviceId);
    if (!set) {
      set = new Set();
      devices.set(deviceId, set);
    }
    set.add(client);
    return client;
  }

  remove(client: Client) {
    const devices = this.byUser.get(client.userId);
    const set = devices?.get(client.deviceId);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) devices!.delete(client.deviceId);
    if (devices!.size === 0) this.byUser.delete(client.userId);
  }

  send(client: Client, msg: ServerMessage): boolean {
    if (client.socket.readyState !== 1) return false;
    try {
      client.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  sendTo(deviceId: string, msg: ServerMessage): boolean {
    let any = false;
    for (const devices of this.byUser.values()) {
      const set = devices.get(deviceId);
      if (!set) continue;
      for (const c of set) any = this.send(c, msg) || any;
    }
    return any;
  }

  /** 广播只发给同一用户的设备。跨用户广播就是数据泄漏 */
  broadcastToUser(userId: string, msg: ServerMessage) {
    const devices = this.byUser.get(userId);
    if (!devices) return;
    for (const set of devices.values()) {
      for (const c of set) this.send(c, msg);
    }
  }

  isOnline(deviceId: string): boolean {
    for (const devices of this.byUser.values()) {
      const set = devices.get(deviceId);
      if (!set) continue;
      for (const c of set) if (c.socket.readyState === 1) return true;
    }
    return false;
  }

  get connectionCount() {
    let n = 0;
    for (const devices of this.byUser.values()) {
      for (const set of devices.values()) n += set.size;
    }
    return n;
  }
}

export const hub = new Hub();
