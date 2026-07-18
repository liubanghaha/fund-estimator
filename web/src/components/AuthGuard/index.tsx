import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useUserStore();
  const nav = useNavigate();

  if (!isLoggedIn) {
    nav('/login', { replace: true });
    return null;
  }
  return <>{children}</>;
}
