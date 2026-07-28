import { useState, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fetchFundInfo, fetchFundEstimate, holding, watchlist, transaction } from '../../api';
import { useUserStore } from '../../stores/user';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';

export default function AddHoldingPage() {
  const c = useThemeColors();
  const { fundCode: pc } = useParams<{ fundCode: string }>();
  const [sp] = useSearchParams();
  const editId = sp.get('id');
  const nav = useNavigate();
  const { isLoggedIn } = useUserStore();
  const isEdit = !!editId;

  // 表单字段
  const [code, setCode] = useState(pc || '');
  const [name, setName] = useState('');
  const [mv, setMv] = useState('');               // 持有金额 marketValue
  const [hrAbs, setHrAbs] = useState('');          // 持有收益绝对值
  const [hrSign, setHrSign] = useState<'+' | '-'>('+');
  const [buyDate, setBuyDate] = useState('');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState<string[]>(() => {
    const raw = storage.get<string[]>('holding_groups_cache') || [];
    return Array.isArray(raw) ? raw : [];
  });
  const [showGroups, setShowGroups] = useState(false);

  // 加减仓（编辑模式）
  const [adjAbs, setAdjAbs] = useState('');
  const [adjSign, setAdjSign] = useState<'+' | '-'>('+');
  const [adjDate, setAdjDate] = useState('');
  const [adjNote, setAdjNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [lookedUp, setLookedUp] = useState(false);
  const [_rawHolding, setRawHolding] = useState<any>(null);

  // 初始化加载分组
  useEffect(() => {
    holding.getGroups().then(r => {
      if (r.code === 0 && r.data?.length) {
        const merged = [...new Set([...groups, ...r.data])].sort();
        setGroups(merged);
        storage.set('holding_groups_cache', merged);
      }
    }).catch(() => { });
  }, []);

  // 编辑模式：加载已有持仓
  useEffect(() => {
    if (!editId) return;
    (async () => {
      try {
        const r = await holding.get(editId);
        if (r.code !== 0 || !r.data) return;
        const h = r.data;
        setRawHolding(h);
        setCode(h.fundCode || '');
        setName(h.fundName || '');

        // 获取最新净值重算市值和收益
        let marketVal = parseFloat(h.marketValue) || 0;
        let holdRet = parseFloat(h.holdingReturn) || 0;
        const shares = parseFloat(h.shares) || 0;
        const buyPrice = parseFloat(h.buyPrice) || 0;
        try {
          const est = await fetchFundEstimate(h.fundCode);
          const nav = est.data?.actualNav || est.data?.nav;
          if (nav && shares > 0 && buyPrice > 0) {
            marketVal = parseFloat((nav * shares).toFixed(2));
            holdRet = parseFloat(((nav - buyPrice) * shares).toFixed(2));
          }
        } catch { /* 沿用 DB 值 */ }

        setMv(String(marketVal || ''));
        setHrSign(holdRet >= 0 ? '+' : '-');
        setHrAbs(String(Math.abs(holdRet) || ''));
        setBuyDate(h.buyDate || '');
        setGroup(h.group || '');
        setLookedUp(true);
      } catch { /* 加载失败不阻塞 */ }
    })();
  }, [editId]);

  const hr = parseFloat(hrAbs || '0') * (hrSign === '+' ? 1 : -1);

  // 查询基金名称
  const lookup = async () => {
    if (!code || code.length !== 6) return;
    setLoading(true);
    try {
      const r = await fetchFundInfo(code);
      if (r.code === 0 && r.data) {
        setName(r.data.fundName || '');
        setLookedUp(true);
      } else {
        alert('未找到该基金');
      }
    } catch { alert('查询失败'); }
    setLoading(false);
  };

  // 保存
  const save = async () => {
    if (!isLoggedIn) { nav('/login'); return; }
    if (!code.trim()) { alert('请输入基金代码'); return; }
    if (!name.trim()) { alert('请输入基金名称'); return; }
    const mvVal = parseFloat(mv);
    const adjVal = isEdit ? parseFloat(adjAbs || '0') * (adjSign === '+' ? 1 : -1) : 0;
    if (!adjVal && (!mvVal || mvVal <= 0)) { alert('请输入有效持有金额'); return; }
    if (!buyDate) { alert('请选择买入日期'); return; }

    setLoading(true);
    try {
      // 获取当前净值
      const est = await fetchFundEstimate(code.trim());
      if (est.code !== 0) { alert('获取净值失败'); setLoading(false); return; }
      const curNav = est.data?.actualNav || est.data?.nav;
      if (!curNav || curNav <= 0) { alert('获取净值失败'); setLoading(false); return; }

      let shares: number, buyPrice: number, finalMV: number, finalHR: number;
      const today = new Date().toISOString().slice(0, 10);

      if (isEdit && adjVal !== 0 && _rawHolding) {
        // 加减仓
        const h = _rawHolding;
        const type = adjVal > 0 ? 'buy' : 'sell';
        const absAmt = Math.abs(adjVal);
        const adjShares = parseFloat((absAmt / curNav).toFixed(2));
        const oldS = parseFloat(h.shares || h.amount || 0);
        const oldP = parseFloat(h.buyPrice || h.nav || 0);
        const oldMV = parseFloat(h.marketValue) || 0;

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
          fundCode: code.trim(), fundName: name.trim(),
          type, shares: adjShares, price: curNav, amount: absAmt,
          date: adjDate || today,
          note: adjNote.trim() || '',
        });

        shares = ns;
        buyPrice = np;
        finalMV = newMV;
        finalHR = +(newMV - ns * np).toFixed(2);
      } else {
        // 新增 / 纯编辑
        shares = parseFloat((mvVal / curNav).toFixed(2));
        if (shares <= 0) shares = parseFloat((mvVal / curNav).toFixed(4));
        if (shares <= 0) shares = 0.01;
        buyPrice = parseFloat((curNav - hr / shares).toFixed(4));
        finalMV = mvVal;
        finalHR = hr;
      }

      const buyAmount = parseFloat((shares * buyPrice).toFixed(2));

      const data: Record<string, unknown> = {
        fundCode: code.trim(), fundName: name.trim(),
        buyPrice, shares,
        marketValue: finalMV, holdingReturn: finalHR,
        buyAmount, buyDate,
        group: group || '',
      };

      if (isEdit) {
        const r = await holding.update(editId, data);
        if (r.code !== 0) { alert(r.msg || '更新失败'); setLoading(false); return; }
      } else {
        const r = await holding.add(data);
        if (r.code === 409) { alert('该基金已在持仓中'); setLoading(false); return; }
        if (r.code !== 0) { alert(r.msg || '添加失败'); setLoading(false); return; }
        // 自动加入自选
        watchlist.add(code.trim(), name.trim()).catch(() => { });
      }

      storage.set('portfolio_force_refresh', true);
      storage.remove('portfolio_cache');

      if (isEdit) {
        nav(-1);
      } else {
        nav('/', { replace: true });
      }
    } catch (e: any) {
      alert('网络错误: ' + (e.message || ''));
    }
    setLoading(false);
  };

  // 删除
  const del = async () => {
    if (!editId) return;
    if (!confirm('确定要删除这条持仓及关联交易记录吗？')) return;
    try {
      await holding.remove(editId);
      storage.set('portfolio_force_refresh', true);
      storage.remove('portfolio_cache');
      nav('/', { replace: true });
    } catch { alert('删除失败'); }
  };

  const inputStyle: React.CSSProperties = {
    flex: 1, padding: '8px 12px', borderRadius: 8,
    border: `1px solid ${c.border}`, outline: 'none', fontSize: 14,
    background: c.cardBg, color: c.text,
  };

  return <div style={{ minHeight: '100vh', background: c.bg }}>
    {/* Header */}
    <div style={{ padding: '10px 16px', background: c.cardBg, display: 'flex', alignItems: 'center' }}>
      <span onClick={() => nav(-1)} style={{ fontSize: 18, cursor: 'pointer', marginRight: 12 }}>‹</span>
      <span style={{ fontWeight: 600, fontSize: 16 }}>{isEdit ? '编辑持仓' : '添加持仓'}</span>
    </div>

    {/* Form */}
    <div style={{ margin: 10, padding: 16, background: c.cardBg, borderRadius: 12 }}>
      {/* 基金代码 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>基金代码</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={code} onChange={e => { setCode(e.target.value); setLookedUp(false); }}
            placeholder="6位代码" maxLength={6} disabled={isEdit}
            style={inputStyle} />
          {!isEdit && <button onClick={lookup} disabled={loading}
            style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${c.primary}`, background: c.cardBg, color: c.primary, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {lookedUp ? '已识别' : '查询'}
          </button>}
        </div>
        {name && <div style={{ marginTop: 4, fontSize: 14, fontWeight: 500 }}>{name}</div>}
      </div>

      {/* 基金名称 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>基金名称</div>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="输入或自动获取" disabled={isEdit}
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
      </div>

      {/* 持有金额 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>持有金额（元）</div>
        <input value={mv} onChange={e => setMv(e.target.value)} type="number" placeholder="0.00"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
      </div>

      {/* 持有收益 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>持有收益（选填）</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${c.border}`, flexShrink: 0 }}>
            <div onClick={() => setHrSign('+')} style={{ padding: '6px 14px', cursor: 'pointer', background: hrSign === '+' ? c.up : c.cardBg, color: hrSign === '+' ? '#fff' : c.textSecondary, fontSize: 14 }}>+</div>
            <div onClick={() => setHrSign('-')} style={{ padding: '6px 14px', cursor: 'pointer', background: hrSign === '-' ? c.down : c.cardBg, color: hrSign === '-' ? '#fff' : c.textSecondary, fontSize: 14 }}>-</div>
          </div>
          <input value={hrAbs} onChange={e => setHrAbs(e.target.value)} type="number" placeholder="0.00"
            style={inputStyle} />
        </div>
      </div>

      {/* 买入日期 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>买入日期</div>
        <input value={buyDate} onChange={e => setBuyDate(e.target.value)} type="date"
          style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', colorScheme: 'light' }} />
      </div>

      {/* 所属分组 */}
      {!isEdit && <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>所属分组</div>
        <div onClick={() => setShowGroups(!showGroups)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: group ? c.text : c.textHint }}>{group || '未分组'}</span>
          <span style={{ color: c.textSecondary, fontSize: 12 }}>{showGroups ? '▴' : '▾'}</span>
        </div>
        {showGroups && <div style={{ marginTop: 4, border: `1px solid ${c.border}`, borderRadius: 8, overflow: 'hidden' }}>
          {['未分组', ...groups.filter((g: string) => g && g !== '未分组' && g !== '全部')].map((g, i) => (
            <div key={i} onClick={() => { setGroup(g === '未分组' ? '' : g); setShowGroups(false); }}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, background: (g === '未分组' ? '' : g) === group ? c.primaryBg : c.cardBg, color: (g === '未分组' ? '' : g) === group ? c.primary : c.text, borderBottom: `1px solid ${c.border}` }}>
              {g}
            </div>
          ))}
          <div onClick={() => {
            const n = prompt('新建分组');
            if (!n?.trim()) { setShowGroups(false); return; }
            const name = n.trim().slice(0, 20);
            if (name === '未分组' || name === '全部') { alert('不能使用保留名称'); return; }
            const gs = [...new Set([...groups, name])].sort();
            setGroups(gs);
            storage.set('holding_groups_cache', gs);
            setGroup(name);
            setShowGroups(false);
          }} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 14, color: c.primary, textAlign: 'center' }}>
            + 新建分组
          </div>
        </div>}
      </div>}

      {/* 加减仓（编辑模式） */}
      {isEdit && <>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>加减持仓（选填，正数加仓负数减仓）</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1px solid ${c.border}`, flexShrink: 0 }}>
              <div onClick={() => setAdjSign('+')} style={{ padding: '6px 14px', cursor: 'pointer', background: adjSign === '+' ? c.up : c.cardBg, color: adjSign === '+' ? '#fff' : c.textSecondary, fontSize: 14 }}>+</div>
              <div onClick={() => setAdjSign('-')} style={{ padding: '6px 14px', cursor: 'pointer', background: adjSign === '-' ? c.down : c.cardBg, color: adjSign === '-' ? '#fff' : c.textSecondary, fontSize: 14 }}>-</div>
            </div>
            <input value={adjAbs} onChange={e => setAdjAbs(e.target.value)} type="number" placeholder="0.00"
              style={inputStyle} />
          </div>
        </div>
        {parseFloat(adjAbs || '0') !== 0 && <>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>交易日期</div>
            <input value={adjDate} onChange={e => setAdjDate(e.target.value)} type="date"
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', colorScheme: 'light' }} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: c.textSecondary, marginBottom: 4 }}>备注（选填）</div>
            <input value={adjNote} onChange={e => setAdjNote(e.target.value)} placeholder="操作理由" maxLength={100}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
          </div>
        </>}
      </>}

      {/* 保存按钮 */}
      <button onClick={save} disabled={loading}
        style={{ width: '100%', padding: 12, borderRadius: 24, border: 'none', background: loading ? c.textHint : c.primary, color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', marginTop: 4 }}>
        {loading ? '保存中...' : isEdit ? '更新持仓' : '保存持仓'}
      </button>

      {/* 删除按钮（编辑模式） */}
      {isEdit && <button onClick={del}
        style={{ width: '100%', padding: 12, marginTop: 8, borderRadius: 24, border: `1px solid ${c.border}`, background: 'transparent', color: c.down, fontSize: 14, cursor: 'pointer' }}>
        删除持仓
      </button>}
    </div>
  </div>;
}
