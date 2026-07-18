import { useThemeStore } from '../stores/theme';

export function useThemeColors() {
  const theme = useThemeStore((s) => s.theme);
  const isRed = theme === 'red';
  return {
    primary: isRed ? '#E4393C' : '#2196F3',
    primaryGradient: isRed ? 'linear-gradient(135deg, #E4393C, #FF6B6B)' : 'linear-gradient(135deg, #1565C0, #42A5F5)',
    up: '#E4393C',
    down: '#2E8B57',
    mid: '#F59E0B',
    bg: '#f5f5f5',
    cardBg: '#fff',
    text: '#333',
    textSecondary: '#999',
    textHint: '#ccc',
    border: '#eee',
    primaryBg: isRed ? '#FFF0F0' : '#E3F2FD',
    downBg: '#F0FFF5',
  };
}
