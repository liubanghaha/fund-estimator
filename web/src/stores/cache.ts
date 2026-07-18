import { create } from 'zustand';

interface CacheState {
  get: <T>(key: string) => T | null;
  set: <T>(key: string, value: T) => void;
  remove: (key: string) => void;
}

export const useCacheStore = create<CacheState>(() => ({
  get: <T>(key: string): T | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set: <T>(key: string, value: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // quota exceeded
    }
  },
  remove: (key: string) => {
    localStorage.removeItem(key);
  },
}));

// 便捷工具函数
export const storage = {
  get: <T>(key: string): T | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set: <T>(key: string, value: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  },
  remove: (key: string) => localStorage.removeItem(key),
};
