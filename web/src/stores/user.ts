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
    set({ uid, isLoggedIn: loggedIn, openid, loading: false });
  },

  login: (openid: string) => {
    const uid = getStoredUid();
    safeSet('h5_logged_in', '1');
    safeSet('h5_bound_openid', openid);
    set({ uid, openid, isLoggedIn: true });
  },

  logout: () => {
    safeRemove('h5_logged_in');
    set({ isLoggedIn: false });
  },

  bindOpenid: (openid: string) => {
    safeSet('h5_bound_openid', openid);
    set({ openid });
  },

  unbindOpenid: () => {
    safeRemove('h5_bound_openid');
    safeRemove('h5_logged_in');
    set({ openid: '', isLoggedIn: false });
  },

  // 使用绑定的 OPENID（登录即绑定，必存在）
  getEffectiveUid: () => {
    const { openid } = get();
    return openid;
  },
}));

