import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPortfolio, fetchFundEstimate, transaction, holding } from '../../api';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';

export default function AdjustHoldingPage() {
  const c = useThemeColors();
  const nav = useNavigate();
  const [hs, setHs] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [type, setType] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await getPortfolio();
        if (r.code === 0) setHs(r.data?.holdings || []);
      } catch { }
    })();
  }, []);

  const save = async () => {
    if (!sel || !amount || parseFloat(amount) <= 0) { alert('请选择基金并输入有效金额'); return; }
    if (!date) { alert('请选择交易日期'); return; }
    setLoading(true);
    try {
      // 获取当前净值
      const est = await fetchFundEstimate(sel.fundCode);
      const curNav = est.data?.actualNav || est.data?.nav || est.data?.estimatedNav;
      if (!curNav || curNav <= 0) { alert('获取净值失败'); setLoading(false); return; }

      const absAmt = parseFloat(amount);
      const adjShares = parseFloat((absAmt / curNav).toFixed(2));
      const oldS = parseFloat(sel.shares || 0);
      const oldP = parseFloat(sel.buyPrice || sel.nav || 0);
      const oldMV = parseFloat(sel.marketValue) || 0;
      const txDate = date;

      if (type === 'sell' && adjShares > oldS) {
        alert('卖出份额超出当前持有'); setLoading(false); return;
      }

      let ns: number, np: number, newMV: number;
      if (type === 'buy') {
        ns = oldS + adjShares;
        np = (oldP * oldS + curNav * adjShares) / ns;
        newMV = +(oldMV + absAmt).toFixed(2);
      } else {
        ns = oldS - adjShares;
        np = oldP;
        newMV = +(oldMV - absAmt).toFixed(2);
      }

      // 写交易记录
      await transaction.add({
        fundCode: sel.fundCode, fundName: sel.fundName,
        type, shares: adjShares, price: nav, amount: absAmt,
        date: txDate,
        note: note.trim() || '',
      });

      // 更新持仓数据
      const buyAmount = parseFloat((ns * np).toFixed(2));
      const newHR = +(newMV - ns * np).toFixed(2);
      await holding.update(sel._id, {
        shares: parseFloat(ns.toFixed(4)),
        buyPrice: parseFloat(np.toFixed(4)),
        buyAmount,
        marketValue: newMV,
        holdingReturn: newHR,
      });

      storage.set('portfolio_force_refresh', true);
      storage.remove('portfolio_cache');
      nav(-1);
    } catch (e: any) { alert('保存失败: ' + (e.message || '')); }
    setLoading(false);
  };

  return <div style={{ minHeight: '100vh', background: c.bg }}>
    <div style={{ padding: '10px 16px', background: c.cardBg, display: 'flex' }}>
      <span onClick={() => nav(-1)} style={{ fontSize: 18, cursor: 'pointer', marginRight: 12 }}>‹</span>
      <span style={{ fontWeight: 600, fontSize: 16 }}>加减仓</span>
    </div>
    <div style={{ margin: 10, padding: 16, background: c.cardBg, borderRadius: 12 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>选择基金</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {hs.map(h => <div key={h._id} onClick={() => setSel(h)}
            style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${sel?._id === h._id ? c.primary : c.border}`, background: sel?._id === h._id ? c.primaryBg : c.cardBg, fontSize: 13, cursor: 'pointer' }}>
            {h.fundName}
          </div>)}
        </div>
        {hs.length === 0 && <div style={{ textAlign: 'center', padding: 20, color: c.textSecondary }}>暂无持仓</div>}
      </div>

      {sel && <>
        {/* 现持信息 */}
        <div style={{ marginBottom: 12, padding: 10, background: c.bg, borderRadius: 8, fontSize: 13, color: c.textSecondary }}>
          <div>当前份额: {parseFloat(sel.shares || 0).toFixed(2)} | 成本: ¥{(parseFloat(sel.buyPrice || 0) * parseFloat(sel.shares || 0)).toFixed(2)}</div>
        </div>

        {/* 买入/卖出切换 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${c.border}` }}>
            <div onClick={() => setType('buy')} style={{ flex: 1, textAlign: 'center', padding: 10, cursor: 'pointer', background: type === 'buy' ? c.up : c.cardBg, color: type === 'buy' ? '#fff' : c.text, fontWeight: type === 'buy' ? 600 : 400 }}>买入</div>
            <div onClick={() => setType('sell')} style={{ flex: 1, textAlign: 'center', padding: 10, cursor: 'pointer', background: type === 'sell' ? c.down : c.cardBg, color: type === 'sell' ? '#fff' : c.text, fontWeight: type === 'sell' ? 600 : 400 }}>卖出</div>
          </div>
        </div>

        {[{ l: '金额（元）', v: amount, on: (e: any) => setAmount(e.target.value), ph: '交易金额' }].map(f =>
          <div key={f.l} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>{f.l}</div>
            <input value={f.v} onChange={f.on} type="number" placeholder={f.ph}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${c.border}`, outline: 'none', fontSize: 14, background: c.cardBg, boxSizing: 'border-box' }} />
          </div>)}

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>交易日期（默认今天）</div>
          <input value={date} onChange={e => setDate(e.target.value)} type="date"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${c.border}`, outline: 'none', fontSize: 14, background: c.cardBg, boxSizing: 'border-box', colorScheme: 'light' }} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="备注（选填）"
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${c.border}`, outline: 'none', fontSize: 14, background: c.cardBg, boxSizing: 'border-box' }} />
        </div>

        <button onClick={save} disabled={loading}
          style={{ width: '100%', padding: 12, borderRadius: 24, border: 'none', background: loading ? c.textHint : type === 'buy' ? c.up : c.down, color: '#fff', fontSize: 16, cursor: 'pointer' }}>
          {loading ? '保存中...' : `确认${type === 'buy' ? '买入' : '卖出'}`}
        </button>
      </>}
    </div>
  </div>;
}
