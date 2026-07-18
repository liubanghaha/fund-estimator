import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './stores/theme';
import { useUserStore } from './stores/user';
import TabBar from './components/TabBar';
import AuthGuard from './components/AuthGuard';
import { ToastProvider } from './components/Toast';

const IndexPage = lazy(() => import('./pages/index'));
const WatchlistPage = lazy(() => import('./pages/watchlist'));
const UserCenterPage = lazy(() => import('./pages/user-center'));
const FundDetailPage = lazy(() => import('./pages/fund-detail'));
const ProfitDetailPage = lazy(() => import('./pages/profit-detail'));
const SearchPage = lazy(() => import('./pages/search'));
const AddHoldingPage = lazy(() => import('./pages/add-holding'));
const AdjustHoldingPage = lazy(() => import('./pages/adjust-holding'));
const FundComparePage = lazy(() => import('./pages/fund-compare'));
const CorrelationMatrixPage = lazy(() => import('./pages/correlation-matrix'));
const LoginPage = lazy(() => import('./pages/login'));
const ImportDataPage = lazy(() => import('./pages/import-data'));

export default function App() {
  const theme = useThemeStore((s) => s.theme);
  const init = useUserStore((s) => s.init);

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  useEffect(() => { init(); }, [init]);

  return (
    <ToastProvider>
    <BrowserRouter>
      <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: '#999' }}>加载中...</div>}>
        <Routes>
          <Route path="/" element={<TabBar />}>
            <Route index element={<IndexPage />} />
            <Route path="watchlist" element={<WatchlistPage />} />
            <Route path="user-center" element={<UserCenterPage />} />
          </Route>
          <Route path="/fund-detail/:fundCode" element={<FundDetailPage />} />
          <Route path="/profit-detail" element={<AuthGuard><ProfitDetailPage /></AuthGuard>} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/add-holding" element={<AuthGuard><AddHoldingPage /></AuthGuard>} />
          <Route path="/add-holding/:fundCode" element={<AuthGuard><AddHoldingPage /></AuthGuard>} />
          <Route path="/adjust-holding" element={<AuthGuard><AdjustHoldingPage /></AuthGuard>} />
          <Route path="/fund-compare" element={<FundComparePage />} />
          <Route path="/correlation-matrix" element={<AuthGuard><CorrelationMatrixPage /></AuthGuard>} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/import-data" element={<ImportDataPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
    </ToastProvider>
  );
}
