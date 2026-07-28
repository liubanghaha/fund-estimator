import { create } from 'zustand';

type Theme = 'red' | 'blue';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

function getStoredTheme(): Theme {
  const v = localStorage.getItem('theme');
  return v === 'red' || v === 'blue' ? v : 'red';
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: getStoredTheme(),
  setTheme: (theme: Theme) => {
    localStorage.setItem('theme', theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next = get().theme === 'red' ? 'blue' : 'red';
    localStorage.setItem('theme', next);
    set({ theme: next });
  },
}));
