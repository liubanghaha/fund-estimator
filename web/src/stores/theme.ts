import { create } from 'zustand';

type Theme = 'red' | 'blue';

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: (localStorage.getItem('theme') as Theme) || 'red',
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
