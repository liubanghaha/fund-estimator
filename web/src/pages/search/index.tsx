import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchFund } from '../../api';
import { useThemeColors } from '../../hooks/useThemeColors';

export default function SearchPage() {
  const c = useThemeColors();
  const nav = useNavigate();
  const [kw, setKw] = useState('');
  const [r, setR] = useState<any[]>([]);
  const [l, setL] = useState(false);
  const [s, setS] = useState(false);
  const timerRef = useRef<any>(null);
  const seqRef = useRef(0);

  const doSearch = useCallback(async (k: string, seq: number) => {
    if (k.trim().length < 2) { setR([]); return; }
    setL(true); setS(true);
    try {
      const res = await searchFund(k.trim());
      if (seq !== seqRef.current) return; // ignore stale response
      if (res.code === 0) setR(Array.isArray(res.data) ? res.data : []);
    } catch { }
    if (seq === seqRef.current) setL(false);
  }, []);

  const handleInput = (val: string) => {
    setKw(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      seqRef.current++;
      doSearch(val, seqRef.current);
    }, 300);
  };

  return <div style={{ minHeight: '100vh', background: c.bg }}>
    <div style={{ padding: '8px 12px', background: c.cardBg, display: 'flex', gap: 8 }}>
      <span onClick={() => nav(-1)} style={{ fontSize: 18, cursor: 'pointer' }}>‹</span>
      <input placeholder="输入基金代码或名称" value={kw} onChange={e => handleInput(e.target.value)}
        style={{ flex: 1, padding: '8px 12px', borderRadius: 20, border: `1px solid ${c.border}`, outline: 'none', fontSize: 14 }} />
    </div>
    {l ? <div style={{ textAlign: 'center', padding: 48, color: c.textSecondary }}>搜索中...</div> :
      s && r.length === 0 ? <div style={{ textAlign: 'center', padding: 48, color: c.textSecondary }}>未找到匹配基金</div> :
        r.map(x => <div key={x.code || x.fundCode} onClick={() => nav(`/fund-detail/${x.code || x.fundCode}`)}
          style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 16px', margin: '4px 12px', background: c.cardBg, borderRadius: 10, cursor: 'pointer' }}>
          <div><div style={{ fontSize: 15, fontWeight: 500 }}>{x.fundName || x.name}</div>
            <div style={{ fontSize: 12, color: c.textSecondary }}>{x.code || x.fundCode} {x.fundType || ''}</div></div>
          <span style={{ color: c.primary, fontSize: 13 }}>详情 ›</span>
        </div>)}
  </div>;
}
