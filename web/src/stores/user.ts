import { create } from 'zustand';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* quota exceeded */ }
}
function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function generateUid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'h5_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getStoredUid(): string {
  let uid = safeGet('h5_uid');
  if (!uid) {
    uid = generateUid();
    safeSet('h5_uid', uid);
  }
  return uid;
}

// 最近一次已过的定时登出点（每天 9:00 / 16:00，本地时间）
function getLastLogoutPoint(now: Date): number {
  const today9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
  const today16 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0, 0, 0);
  if (now >= today16) return today16.getTime();
  if (now >= today9) return today9.getTime();
  return today9.getTime() - 17 * 3600 * 1000; // 昨天 16:00
}

interface UserState {
  uid: string;
  openid: string;       // 绑定的小程序 OPENID（登录凭证）
  isLoggedIn: boolean;
  loading: boolean;
  init: () => void;
  login: (openid: string) => void;
  logout: () => void;
  bindOpenid: (openid: string) => void;
  unbindOpenid: () => void;
  getEffectiveUid: () => string;  // 返回绑定的 OPENID
}

export const useUserStore = create<UserState>((set, get) => ({
  uid: getStoredUid(),
  openid: safeGet('h5_bound_openid') || '',
  isLoggedIn: !!safeGet('h5_logged_in'),
  loading: false,

  init: () => {
    const uid = getStoredUid();
    const loggedIn = !!safeGet('h5_logged_in');
    const openid = safeGet('h5_bound_openid') || '';
    // 定时登出：登录时间早于最近一次 9:00/16:00 登出点则强制登出（账号安全，需重新验证）
    if (loggedIn) {
      const loginTime = Number(safeGet('h5_login_time') || 0);
      if (!loginTime || loginTime < getLastLogoutPoint(new Date())) {
        safeRemove('h5_logged_in');
        safeRemove('h5_bound_openid');
        safeRemove('h5_login_time');
        set({ uid, openid: '', isLoggedIn: false, loading: false });
        return;
      }
    }
    set({ uid, isLoggedIn: loggedIn, openid, loading: false });
  },

  login: (openid: string) => {
    const uid = getStoredUid();
    safeSet('h5_logged_in', '1');
    safeSet('h5_bound_openid', openid);
    safeSet('h5_login_time', String(Date.now()));
    set({ uid, openid, isLoggedIn: true });
  },

  logout: () => {
    safeRemove('h5_logged_in');
    safeRemove('h5_login_time');
    set({ isLoggedIn: false });
  },

  bindOpenid: (openid: string) => {
    safeSet('h5_bound_openid', openid);
    set({ openid });
  },

  unbindOpenid: () => {
    safeRemove('h5_bound_openid');
    safeRemove('h5_logged_in');
    safeRemove('h5_login_time');
    set({ openid: '', isLoggedIn: false });
  },

  // 使用绑定的 OPENID（登录即绑定，必存在）
  getEffectiveUid: () => {
    const { openid } = get();
    return openid;
  },
}));

