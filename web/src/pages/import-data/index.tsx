import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';
import { callFunction } from '../../cloudbase';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';

export default function ImportDataPage() {
  const c = useThemeColors();
  const nav = useNavigate();
  const { uid } = useUserStore();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<null | { counts: { holdings: number; watchlist: number; transactions: number }; msg: string }>(null);
  const [error, setError] = useState('');

  async function doImport() {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);

    try {
      // 1. 获取迁移数据
      const res = await callFunction('transferData', { action: 'import', code: code.trim().toUpperCase() });
      const d = (res as any).result || res;
      if (d.code !== 0) {
        setError(d.msg || '导入失败');
        setLoading(false);
        return;
      }

      const { holdings, watchlist, transactions } = d.data || {};
      const hCount = holdings?.length || 0;
      const wCount = watchlist?.length || 0;
      const tCount = transactions?.length || 0;

      // 2. 批量导入持仓
      if (hCount > 0) {
        const funds = holdings.map((h: any) => ({
          ...h,
          testOpenid: uid,
        }));
        await callFunction('batchAddHoldings', { funds });
      }

      // 3. 批量导入自选
      if (wCount > 0) {
        for (const w of watchlist) {
          try {
            await callFunction('manageWatchlist', {
              action: 'add',
              fundCode: w.fundCode,
              fundName: w.fundName,
              testOpenid: uid,
            });
          } catch (e) { /* skip duplicates */ }
        }
      }

      // 4. 导入交易记录
      if (tCount > 0) {
        for (const t of transactions) {
          try {
            await callFunction('manageTransaction', {
              action: 'add',
              data: { ...t, testOpenid: uid },
            });
          } catch (e) { /* skip */ }
        }
      }

      // 清除缓存触发刷新
      storage.remove('portfolio_cache');

      setResult({
        counts: { holdings: hCount, watchlist: wCount, transactions: tCount },
        msg: '数据导入成功！',
      });
    } catch (e: any) {
      setError(e.message || '网络错误');
    }
    setLoading(false);
  }

  return (
    <div style={{ minHeight: '100vh', background: c.bg, padding: '16px' }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#333', marginBottom: 8 }}>从小程序导入数据</div>
      <div style={{ fontSize: 13, color: '#999', marginBottom: 24 }}>在小程序「我的」→「迁移到网页版」获取迁移码</div>

      {!result && (
        <>
          <div style={{ background: c.cardBg, borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 14, color: '#666', marginBottom: 8 }}>输入迁移码</div>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="如 A3X9K2"
              maxLength={6}
              style={{
                width: '100%', padding: '12px 16px', fontSize: 24, fontWeight: 700,
                letterSpacing: 8, textAlign: 'center', borderRadius: 12,
                border: `2px solid ${code.trim().length === 6 ? '#4CAF50' : c.border}`,
                outline: 'none', background: c.cardBg, boxSizing: 'border-box',
              }}
            />
          </div>

          {error && (
            <div style={{ padding: 12, background: '#FFF3F3', borderRadius: 8, color: '#E4393C', fontSize: 14, marginBottom: 16 }}>
              {error}
            </div>
          )}

          <button
            onClick={doImport}
            disabled={loading || code.trim().length < 6}
            style={{
              width: '100%', padding: 14, borderRadius: 24, border: 'none',
              background: code.trim().length === 6 ? '#4CAF50' : '#CCC',
              color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {loading ? '导入中...' : '开始导入'}
          </button>
        </>
      )}

      {result && (
        <div style={{ background: c.cardBg, borderRadius: 12, padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 60, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#4CAF50', marginBottom: 16 }}>{result.msg}</div>
          <div style={{ fontSize: 14, color: '#666', lineHeight: 2 }}>
            <div>📊 {result.counts.holdings} 条持仓记录</div>
            <div>⭐ {result.counts.watchlist} 只自选基金</div>
            <div>📝 {result.counts.transactions} 条交易记录</div>
          </div>
          <button
            onClick={() => { nav('/'); window.location.reload(); }}
            style={{
              width: '100%', marginTop: 24, padding: 14, borderRadius: 24, border: 'none',
              background: '#4CAF50', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer',
            }}
          >
            返回首页查看
          </button>
        </div>
      )}
    </div>
  );
}
