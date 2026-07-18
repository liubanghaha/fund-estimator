import { create } from 'zustand';

function generateUid(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'h5_';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getStoredUid(): string {
  let uid = localStorage.getItem('h5_uid');
  if (!uid) {
    uid = generateUid();
    localStorage.setItem('h5_uid', uid);
  }
  return uid;
}

interface UserState {
  uid: string;
  openid: string;       // 绑定的旧账号 OPENID（空表示新账号）
  isLoggedIn: boolean;
  loading: boolean;
  init: () => void;
  login: () => void;
  logout: () => void;
  bindOpenid: (openid: string) => void;
  unbindOpenid: () => void;
  getEffectiveUid: () => string;  // 优先返回绑定的 OPENID
}

export const useUserStore = create<UserState>((set, get) => ({
  uid: getStoredUid(),
  openid: localStorage.getItem('h5_bound_openid') || '',
  isLoggedIn: !!localStorage.getItem('h5_logged_in'),
  loading: false,

  init: () => {
    const uid = getStoredUid();
    const loggedIn = !!localStorage.getItem('h5_logged_in');
    const openid = localStorage.getItem('h5_bound_openid') || '';
    set({ uid, isLoggedIn: loggedIn, openid, loading: false });
  },

  login: () => {
    const uid = getStoredUid();
    localStorage.setItem('h5_logged_in', '1');
    set({ uid, isLoggedIn: true });
  },

  logout: () => {
    localStorage.removeItem('h5_logged_in');
    set({ isLoggedIn: false });
  },

  bindOpenid: (openid: string) => {
    localStorage.setItem('h5_bound_openid', openid);
    set({ openid });
  },

  unbindOpenid: () => {
    localStorage.removeItem('h5_bound_openid');
    set({ openid: '' });
  },

  // 优先使用绑定的 OPENID（能看旧数据），否则用本地 UID（新账号）
  getEffectiveUid: () => {
    const { openid, uid } = get();
    return openid || uid;
  },
}));

