import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';

export default function AuthGuard({ children }: { children: ReactNode }) {
  const isLoggedIn = useUserStore(s => s.isLoggedIn);
  const nav = useNavigate();

  useEffect(() => {
    if (!isLoggedIn) nav('/login', { replace: true });
  }, [isLoggedIn, nav]);

  if (!isLoggedIn) return null;
  return <>{children}</>;
}
