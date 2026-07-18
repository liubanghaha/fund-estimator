import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const tabs = [
  { key: '/', label: '持仓', icon: '📊' },
  { key: '/watchlist', label: '自选', icon: '⭐' },
  { key: '/user-center', label: '我的', icon: '👤' },
];

export default function TabBarLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const active = loc.pathname === '/' ? '/' : '/' + loc.pathname.split('/')[1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <Outlet />
      </div>
      <div style={{ display: 'flex', background: '#fff', borderTop: '1px solid #eee', paddingBottom: 'env(safe-area-inset-bottom, 0px)', flexShrink: 0 }}>
        {tabs.map((t) => (
          <div key={t.key} onClick={() => nav(t.key)}
            style={{ flex: 1, textAlign: 'center', padding: '5px 0', cursor: 'pointer', color: active === t.key ? '#E4393C' : '#999' }}>
            <div style={{ fontSize: 18 }}>{t.icon}</div>
            <div style={{ fontSize: 9, marginTop: 1 }}>{t.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
