import { useState,useEffect,useCallback,useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';
import { getPortfolio,holding as holdingApi } from '../../api';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';
import { showToast } from '../../components/Toast';
import IndexBar from './IndexBar';
import GroupTabs from './GroupTabs';

const ALL_INDICES=[{code:'000001',name:'上证指数'},{code:'399001',name:'深证成指'},{code:'399006',name:'创业板指'},{code:'000300',name:'沪深300'},{code:'HSTECH',name:'恒生科技'},{code:'HSI',name:'恒生指数'},{code:'SPX',name:'标普500'},{code:'IXIC',name:'纳斯达克'}];

interface Holding{_id:string;fundCode:string;fundName:string;shares?:number;buyPrice?:number;marketValue?:number;todayProfit?:string;todayProfitRate?:string;estimateRate?:string;totalReturn?:string;totalReturnRate?:string;nav?:string;estimateUpdated?:boolean;group?:string;navHigh?:string|null;navLow?:string|null;peTemp?:{signal?:string;normPE?:number}}

export default function IndexPage(){
  const c=useThemeColors();
  const {isLoggedIn}=useUserStore();const nav=useNavigate();
  const [holdings,setHoldings]=useState<Holding[]>([]);
  const [display,setDisplay]=useState<Holding[]>([]);
  const [loading,setLoading]=useState(false);const [ready,setReady]=useState(false);
  const [loadErr,setLoadErr]=useState(false);
  const [amountV,setAmountV]=useState(storage.get<boolean>('amountVisible')??true);
  const [totalAmt,setTotalAmt]=useState('0.00');const [todayP,setTodayP]=useState('0.00');
  const [todayPR,setTodayPR]=useState('0.00');const [totalR,setTotalR]=useState('0.00');
  const [totalRR,setTotalRR]=useState('0.00');const [updTime,setUpdTime]=useState('');
  const [fromCache,setFromCache]=useState(false);const [allUpdated,setAllUpdated]=useState(false);
  const [sortF,setSortF]=useState<'todayProfit'|'totalReturn'>('todayProfit');
  const [sortO,setSortO]=useState<'desc'|'asc'>('desc');
  const [batch,setBatch]=useState(false);const [chk,setChk]=useState<Record<string,boolean>>({});
  const [activeG,setActiveG]=useState('all');
  const [groups,setGroups]=useState<string[]>(()=>{
    const raw=storage.get<string[]>('holding_groups_cache')||[];
    return raw.map(g=>typeof g==='string'?g:String(g?.name||g)).filter(Boolean);
  });
  const [gCounts,setGCounts]=useState<Record<string,number>>({});
  const [groupSummary,setGSummary]=useState<any>(null);
  const [allGData,setAllGData]=useState<any[]>([]);
  const [colOrder,setColOrder]=useState<string[]>(storage.get<string[]>('colOrder')||['todayProfit','totalReturn','valuation']);
  const [showColEd,setShowColEd]=useState(false);const [showTemp,setShowTemp]=useState(false);
  const [showGpick,setShowGpick]=useState(false);const [gpCodes,setGpCodes]=useState<string[]>([]);
  const [showShare,setShowShare]=useState(false);
  // Alert settings
  const [showAlert,setShowAlert]=useState(false);
  const [showToastCode,setAlertCode]=useState('');const [showToastName,setAlertName]=useState('');
  const [showToastUpper,setAlertUpper]=useState('');const [showToastLower,setAlertLower]=useState('');
  const [showToastPe,setAlertPe]=useState(false);
  const [idxExpand,setIdxExpand]=useState(false);
  const [idxEdit,setIdxEdit]=useState(false);
  const [activeIdx,setActiveIdx]=useState(()=>{
    const saved=storage.get<string[]>('indexCodes');
    if(saved?.length) return ALL_INDICES.filter(i=>saved.includes(i.code));
    return ALL_INDICES.slice(0,6);
  });
  const lastFetch=useRef(0);const cacheTs=useRef(0);
  const [showToastSettings] = useState(()=>storage.get<any>('showToastSettings')||{});
  const [peSignalCache] = useState(()=>storage.get<any>('peSignalCache')||{});

  const sortH=useCallback((list:Holding[],f=sortF,o=sortO)=>{
    const d=o==='asc'?1:-1;
    return [...list].sort((a,b)=>{
      if(f==='todayProfit'){if(a.estimateUpdated!==b.estimateUpdated)return a.estimateUpdated?-1:1;return d*(parseFloat(String(a.todayProfit??0))-parseFloat(String(b.todayProfit??0)))}
      return d*(parseFloat(String(a.totalReturn??0))-parseFloat(String(b.totalReturn??0)));
    });
  },[sortF,sortO]);

  const applyF=useCallback((list:Holding[],g:string)=>{
    let f=g==='all'?[...list]:g==='ungrouped'?list.filter(h=>!h.group):list.filter(h=>h.group===g);
    return sortH(f);
  },[sortH]);

  const upCnts=useCallback((list:Holding[])=>{
    const ct:Record<string,number>={all:list.length,ungrouped:0};
    list.forEach(h=>{if(!h.group)ct.ungrouped=(ct.ungrouped||0)+1;else ct[h.group]=(ct[h.group]||0)+1});
    setGCounts(ct);
  },[]);

  const loadData=useCallback(async(sl=false)=>{
    if(!isLoggedIn)return;if(sl)setLoading(true);
    try{const res=await getPortfolio();
      console.log('📦 loadData got:', res);
      if(res.code===0&&res.data){const d=res.data;
        const list:Holding[]=(d.holdings||[]).map((h:any)=>({...h,navHigh:h.navHigh!=null?parseFloat(String(h.navHigh)).toFixed(2):null,navLow:h.navLow!=null?parseFloat(String(h.navLow)).toFixed(2):null}));
        const sorted=sortH(list);setHoldings(sorted);setDisplay(applyF(sorted,activeG));
        setTotalAmt(d.totalAmount??'0.00');
        setTodayP(prev=>parseFloat(d.todayProfit)!==0?d.todayProfit:prev);
        setTodayPR(prev=>parseFloat(d.todayProfitRate)!==0?d.todayProfitRate:prev);
        setTotalR(d.totalReturn??'0.00');setTotalRR(d.totalReturnRate??'0.00');
        setUpdTime(d.updateTime||'');setAllUpdated(sorted.length>0&&sorted.every(h=>h.estimateUpdated));
        setFromCache(false);setLoadErr(false);setAllGData(d.groups||[]);
        const cached=storage.get<string[]>('holding_groups_cache')||[];
        const serverGs=(d.groups||[]).map((g:any)=>typeof g==='string'?g:String(g?.name||''));
        const gs=[...new Set([...cached,...serverGs])].filter(Boolean);setGroups(gs);storage.set('holding_groups_cache',gs);
        upCnts(sorted);
        storage.set('portfolio_cache',{...d,holdings:sorted,ts:Date.now()});
      }
    }catch(e){if(holdings.length===0)setLoadErr(true)}
    setLoading(false);setReady(true);
  },[isLoggedIn,activeG]);

  useEffect(()=>{
    if(!isLoggedIn){setReady(true);setLoading(false);return}
    const cached=storage.get<any>('portfolio_cache');
    if(cached?.holdings?.length){
      cacheTs.current=cached.ts||0;
      const sorted=sortH(cached.holdings);setHoldings(sorted);setDisplay(applyF(sorted,activeG));
      setTotalAmt(cached.totalAmount);setTodayP(cached.todayProfit);setTodayPR(cached.todayProfitRate);
      setTotalR(cached.totalReturn);setTotalRR(cached.totalReturnRate);
      setUpdTime(cached.updateTime||'');setFromCache(true);setAllUpdated(sorted.every((h:any)=>h.estimateUpdated));
      setAllGData(cached.allGroupsData||[]);upCnts(sorted);
      if(cached.healthScore) setHealthRaw(cached.healthScore);
      if(cached.assetAllocation) setAssetAlloc(cached.assetAllocation);
    }
    const now=Date.now();
    if(storage.get<boolean>('portfolio_force_refresh')){storage.remove('portfolio_force_refresh');lastFetch.current=0}
    if(!lastFetch.current||now-lastFetch.current>30000){lastFetch.current=now;loadData(false)}
  },[isLoggedIn]);

  useEffect(()=>{if(holdings.length>0)setDisplay(applyF(holdings,activeG))},[activeG,sortF,sortO]);

  // Check showToasts
  const [showToasts,setAlerts]=useState<any[]>([]);
  useEffect(()=>{
    const triggered:any[]=[];
    const dismissed=storage.get<any>('showToastDismissed')||{};
    const newPeCache={...peSignalCache};
    holdings.forEach(h=>{
      const s=showToastSettings[h.fundCode];if(!s)return;
      if(dismissed[h.fundCode]&&Date.now()-dismissed[h.fundCode]<86400000)return;
      const rate=parseFloat(String(h.todayChangeRate??'0'));
      if((s.upper>0&&rate>=s.upper)||(s.lower<0&&rate<=s.lower))triggered.push({fundCode:h.fundCode,fundName:h.fundName,rate,type:rate>=(s.upper||999)?'up':'down'});
      if(s.peAlert&&h.peTemp&&h.peTemp.signal&&h.peTemp.signal!=='nodata'){
        const prev=peSignalCache[h.fundCode];
        if(prev&&prev!==h.peTemp.signal)triggered.push({fundCode:h.fundCode,fundName:h.fundName,rate:0,type:prev==='low'?'down':'up',peChange:`${prev==='low'?'低估':prev==='mid'?'正常':'高估'}→${h.peTemp.signal==='low'?'低估':h.peTemp.signal==='mid'?'正常':'高估'}`});
        newPeCache[h.fundCode]=h.peTemp.signal;
      }
    });
    storage.set('peSignalCache',newPeCache);
    setAlerts(triggered);
  },[holdings]);

  const [healthRaw,setHealthRaw]=useState<any>(null);
  const hsNum=typeof healthRaw==='number'?healthRaw:(healthRaw?.score??null);
  const [assetAlloc,setAssetAlloc]=useState<any>(null);
  const [showAlloc,setShowAlloc]=useState(false);

  const toggleAmt=()=>{const v=!amountV;setAmountV(v);storage.set('amountVisible',v)};

  // 长按菜单
  const showHoldingMenu=(h:Holding)=>{
    const menu=document.createElement('div');
    menu.style.cssText='position:fixed;inset:0;z-index:200;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.3)';
    const inner=document.createElement('div');
    inner.style.cssText='background:#fff;border-radius:16px 16px 0 0;padding:0;width:100%;max-width:400px';
    const addBtn=(text:string,color:string,fn:()=>void)=>{
      const btn=document.createElement('div');
      btn.textContent=text;btn.style.cssText=`padding:14px 16px;text-align:center;font-size:15px;border-bottom:1px solid #f0f0f0;cursor:pointer;color:${color}`;
      btn.onclick=()=>{menu.remove();fn()};inner.appendChild(btn);
    };
    addBtn('编辑','#333',()=>nav(`/add-holding?id=${h._id}`));
    addBtn('设置提醒','#333',()=>{setAlertCode(h.fundCode);setAlertName(h.fundName);
      const s=(storage.get<any>('showToastSettings')||{})[h.fundCode]||{upper:15,lower:-10};
      setAlertUpper(String(s.upper||''));setAlertLower(String(s.lower||''));setAlertPe(!!s.peAlert);setShowAlert(true)});
    addBtn('移动到分组','#333',()=>{setGpCodes([h.fundCode]);setShowGpick(true)});
    addBtn('删除','#E4393C',async()=>{if(!confirm(`确定要删除此条持仓吗？`))return;
      try{await holdingApi.remove(h._id);storage.set('portfolio_force_refresh',true);loadData(true)}catch{showToast('删除失败')}});
    const cancel=document.createElement('div');
    cancel.textContent='取消';cancel.style.cssText='padding:14px 16px;text-align:center;font-size:15px;color:#999;cursor:pointer;marginTop:4px';
    cancel.onclick=()=>menu.remove();inner.appendChild(cancel);
    menu.appendChild(inner);menu.onclick=e=>{if(e.target===menu)menu.remove()};document.body.appendChild(menu);
  };
  const handleSort=(f:'todayProfit'|'totalReturn')=>{let o:'asc'|'desc'='desc';if(sortF===f)o=sortO==='desc'?'asc':'desc';setSortF(f);setSortO(o);setDisplay(sortH(display,f,o))};
  const up=parseFloat(todayP)>=0;
  const retUp=parseFloat(totalR)>=0;

  if(!isLoggedIn)return <div style={{minHeight:'100vh',background:c.bg,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12}}>
    <div style={{fontSize:48}}>🌿</div><div style={{fontSize:16,color:c.textSecondary}}>登录后可管理持仓</div>
    <button onClick={()=>nav('/login')} style={{padding:'10px 40px',borderRadius:24,border:'none',background:c.primary,color:'#fff',fontSize:15}}>一键登录</button></div>;
  if(loading&&!ready)return <div style={{minHeight:'100vh',background:c.bg,display:'flex',alignItems:'center',justifyContent:'center',color:c.textSecondary}}>加载中...</div>;
  if(loadErr&&holdings.length===0)return <div style={{minHeight:'100vh',background:c.bg,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:12}}>
    <div style={{color:c.textSecondary}}>网络异常</div><button onClick={()=>loadData(true)} style={{padding:'8px 24px',borderRadius:20,border:`1px solid ${c.primary}`,color:c.primary,background:'transparent'}}>重试</button></div>;

  return <div style={{minHeight:'100%',background:c.bg,paddingBottom:10}}>
    {/* Alert bar */}
    {showToasts.length>0&&<div style={{margin:'10px 12px 0',padding:10,background:c.primaryBg,borderRadius:10,display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:13}}>
      <span style={{color:c.primary}}>🔔 {showToasts[0].fundName}: {showToasts[0].peChange||(showToasts[0].type==='up'?'涨超上沿':'跌超下沿')}</span>
      <span onClick={()=>{const d=storage.get<any>('showToastDismissed')||{};showToasts.forEach((a:any)=>d[a.fundCode]=Date.now());storage.set('showToastDismissed',d);setAlerts([])}} style={{cursor:'pointer',color:c.textSecondary}}>✕</span>
    </div>}

    {/* Asset Overview - 参考小程序布局 */}
    <div style={{position:'relative',margin:'10px 12px',padding:'30px 20px 24px',borderRadius:16,background:up?`linear-gradient(135deg,${c.primary},#FF6B6B)`:`linear-gradient(135deg,${c.down},#5DBA7D)`,color:'#fff',textAlign:'center'}} onClick={()=>nav('/profit-detail')}>
      <span onClick={e=>{e.stopPropagation();setShowShare(true)}} style={{position:'absolute',left:16,top:10,fontSize:11,background:'rgba(255,255,255,0.35)',padding:'3px 12px',borderRadius:12,color:'#fff'}}>📤 分享</span>
      <span onClick={e=>{e.stopPropagation();toggleAmt()}} style={{position:'absolute',right:16,top:10,fontSize:11,background:'rgba(255,255,255,0.25)',padding:'3px 12px',borderRadius:12}}>{amountV?'隐藏':'显示'}</span>
      {activeG!=='all'&&groupSummary&&<span style={{display:'inline-block',fontSize:11,background:'rgba(255,255,255,0.25)',padding:'2px 10px',borderRadius:8,marginBottom:8}}>{activeG}</span>}
      <div style={{fontSize:12,opacity:0.85,marginBottom:6}}>今日估算收益{allUpdated&&<span style={{fontSize:9,background:'#fff',color:c.primary,padding:'1px 6px',borderRadius:6,marginLeft:6}}>✓</span>}</div>
      <div style={{fontSize:36,fontWeight:800}}>{up?'+':''}{amountV?todayP:'****'}</div>
      <div style={{fontSize:13,opacity:0.85,marginTop:6,display:'flex',justifyContent:'center',gap:10,flexWrap:'wrap'}}>
        <span>涨幅 {up?'+':''}{todayPR}%</span>
        <span style={{opacity:0.4}}>|</span>
        <span>市值 {amountV?parseFloat(totalAmt).toFixed(2):'****'}</span>
        <span style={{opacity:0.4}}>|</span>
        <span style={{color:retUp?'#fff':'#FFE082'}}>累计 {retUp?'+':''}{amountV?totalR:'****'}</span>
      </div>
    </div>

    {/* Quick Actions */}
    <div style={{display:'flex',justifyContent:'space-around',margin:'8px 12px',padding:12,background:c.cardBg,borderRadius:10}}>
      {[['🔍','搜索',()=>nav('/search')],['➕','新增',()=>nav('/add-holding')],['📝','加减仓',()=>nav('/adjust-holding')],['📊','分析',()=>nav('/correlation-matrix')],['☑️','批量',()=>{setBatch(!batch);setChk({})}]].map(([icon,label,fn])=>(
        <div key={label as string} onClick={fn as any} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2,fontSize:11,color:c.textSecondary,cursor:'pointer'}}><span style={{fontSize:20}}>{icon}</span><span>{label}</span></div>))}
    </div>

    {/* Group Tabs */}
    <GroupTabs groups={groups} activeGroup={activeG} counts={gCounts}
      onGroupChange={(g)=>{setActiveG(g);setBatch(false)}}
      onGroupsChange={setGroups}
      onRenameGroup={async(oldName,newName)=>{
        try{await holdingApi.renameGroup(oldName,newName);storage.set('portfolio_force_refresh',true);loadData(true)}catch{showToast('重命名失败')}
      }}
      onDeleteGroup={async(groupName)=>{
        try{await holdingApi.deleteGroup(groupName);storage.set('portfolio_force_refresh',true);loadData(true)}catch{showToast('删除失败')}
      }}
    />

    {/* Batch bar */}
    {batch&&<div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'6px 16px',background:c.primaryBg,fontSize:13,margin:'4px 12px',borderRadius:8}}>
      <span onClick={()=>{setBatch(false);setChk({})}} style={{color:c.primary,cursor:'pointer'}}>取消</span>
      <span>已选{Object.keys(chk).length}项</span>
      <span onClick={()=>{const all=display.every(h=>chk[h._id]);if(all)setChk({});else{const m:Record<string,boolean>={};display.forEach(h=>m[h._id]=true);setChk(m)}}} style={{cursor:'pointer'}}>{display.every(h=>chk[h._id])?'取消全选':'全选'}</span>
      <span onClick={()=>{const codes=Object.keys(chk);if(codes.length){setGpCodes(codes);setShowGpick(true)}}} style={{cursor:'pointer'}}>移动分组</span>
      <span onClick={async()=>{const sel=display.filter(h=>chk[h._id]);if(!sel.length)return;if(!confirm(`删除${sel.length}个持仓?`))return;for(const h of sel)await holdingApi.remove(h._id).catch(()=>{});setBatch(false);setChk({});storage.set('portfolio_force_refresh',true);loadData(true)}} style={{color:c.primary,cursor:'pointer'}}>删除</span>
    </div>}

    {/* Table Header */}
    <div style={{display:'flex',padding:'8px 16px',fontSize:12,color:c.textSecondary,background:c.cardBg,margin:'4px 12px 0',borderRadius:'8px 8px 0 0',borderBottom:`1px solid ${c.border}`}}>
      <span style={{flex:2}} onContextMenu={e=>{e.preventDefault();setShowColEd(true)}}>基金名称</span>
      {colOrder.includes('todayProfit')&&<span style={{flex:1.5,textAlign:'right',cursor:'pointer',color:sortF==='todayProfit'?c.primary:c.textSecondary}} onClick={()=>handleSort('todayProfit')}>当日收益{sortF==='todayProfit'?(sortO==='desc'?'↓':'↑'):''}</span>}
      {colOrder.includes('totalReturn')&&<span style={{flex:1.5,textAlign:'right',cursor:'pointer',color:sortF==='totalReturn'?c.primary:c.textSecondary}} onClick={()=>handleSort('totalReturn')}>累计收益{sortF==='totalReturn'?(sortO==='desc'?'↓':'↑'):''}</span>}
      {colOrder.includes('valuation')&&<span style={{flex:1.5,textAlign:'right',cursor:'pointer'}} onClick={()=>setShowTemp(!showTemp)}>估值ℹ️</span>}
    </div>

    {/* Holdings */}
    {display.length===0?<div style={{textAlign:'center',padding:32,color:c.textSecondary,background:c.cardBg,margin:'0 12px',borderRadius:'0 0 8px 8px'}}>{activeG==='all'?'暂无持仓':'该分组无持仓'}</div>:
    display.map(h=>{
      const pu=parseFloat(String(h.todayProfit??0))>=0;const ru=parseFloat(String(h.totalReturn??0))>=0;
      const pc=h.peTemp?.signal==='low'?c.down:h.peTemp?.signal==='high'?c.primary:h.peTemp?.signal==='mid'?c.mid:c.textHint;
      const pl=h.peTemp?.signal==='low'?'低估':h.peTemp?.signal==='high'?'高估':h.peTemp?.signal==='mid'?'正常':h.peTemp?.signal||'--';
      let longPressTimer:any;
      return <div key={h._id} style={{display:'flex',alignItems:'center',padding:'10px 16px',background:c.cardBg,margin:'0 12px',borderBottom:`1px solid ${c.bg}`,cursor:batch?'default':'pointer',opacity:h.estimateUpdated?1:0.55,position:'relative'}}
        onClick={()=>batch?setChk(p=>({...p,[h._id]:!p[h._id]})):nav(`/fund-detail/${h.fundCode}`)}
        onContextMenu={e=>{e.preventDefault();if(!batch)showHoldingMenu(h)}}
        onTouchStart={()=>{if(!batch)longPressTimer=setTimeout(()=>showHoldingMenu(h),500)}}
        onTouchMove={()=>clearTimeout(longPressTimer)}
        onTouchEnd={()=>clearTimeout(longPressTimer)}>
        {batch&&<input type="checkbox" checked={!!chk[h._id]} readOnly style={{marginRight:8,flexShrink:0}}/>}
        <div style={{flex:2,minWidth:0}}><div style={{fontSize:14,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.fundName}</div><div style={{fontSize:11,color:c.textSecondary}}>{h.fundCode}{h.group?` · ${h.group}`:''}</div></div>
        {colOrder.includes('todayProfit')&&<div style={{flex:1.5,textAlign:'right',color:pu?c.up:c.down,fontSize:13}}><div style={{fontWeight:600}}>{amountV?(pu?'+':'')+String(h.todayProfit??'--'):'****'}</div><div style={{fontSize:11}}>{h.todayChangeRate??'--'}%</div></div>}
        {colOrder.includes('totalReturn')&&<div style={{flex:1.5,textAlign:'right',color:ru?c.up:c.down,fontSize:13}}><div style={{fontWeight:600}}>{amountV?(ru?'+':'')+String(h.totalReturn??'--'):'****'}</div><div style={{fontSize:11}}>{h.totalReturnRate??'--'}%</div></div>}
        {colOrder.includes('valuation')&&<div style={{flex:1.5,textAlign:'right',fontSize:12}}><div style={{color:pc,fontWeight:600}}>{pl}</div><div style={{fontSize:10,color:c.textSecondary}}>{h.currentNav||h.navHigh||h.navLow?`${h.navLow||'--'}~${h.navHigh||'--'}`:h.currentNav||'--'}</div></div>}
      </div>
    })}

    {/* Index Bar */}
    <IndexBar expanded={idxExpand} onToggle={()=>setIdxExpand(!idxExpand)} editOpen={idxEdit} onEditOpen={()=>setIdxEdit(!idxEdit)} activeIndices={activeIdx} onSaveIndices={(codes)=>{setActiveIdx(codes);storage.set('indexCodes',codes.map(c=>c.code));setIdxEdit(false)}} />

    {/* Column Edit Modal */}
    {showColEd&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setShowColEd(false)}>
      <div style={{background:c.cardBg,borderRadius:12,padding:20,width:280}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:12}}>排序字段</div>
        {colOrder.map((col,i)=><div key={col} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${c.border}`}}>
          <span>{col==='todayProfit'?'当日收益':col==='totalReturn'?'累计收益':'估值'}</span>
          <div>{i>0&&<button onClick={()=>{const o=[...colOrder];[o[i-1],o[i]]=[o[i],o[i-1]];setColOrder(o);storage.set('colOrder',o)}} style={{border:'none',background:'none',cursor:'pointer'}}>↑</button>}{i<colOrder.length-1&&<button onClick={()=>{const o=[...colOrder];[o[i],o[i+1]]=[o[i+1],o[i]];setColOrder(o);storage.set('colOrder',o)}} style={{border:'none',background:'none',cursor:'pointer'}}>↓</button>}</div></div>)}</div></div>}

    {/* Group Picker */}
    {showGpick&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setShowGpick(false)}>
      <div style={{background:c.cardBg,borderRadius:12,padding:16,width:260,maxHeight:'60vh',overflowY:'auto'}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:600,marginBottom:12}}>移动到分组</div>
	        {groups.map((g,i)=><div key={i} style={{padding:'10px 0',borderBottom:`1px solid ${c.border}`,cursor:'pointer'}} onClick={async()=>{try{console.log('移动到分组:',gpCodes,'→',g);const r=await holdingApi.setGroup(gpCodes,g);console.log('结果:',r);if(r.code===0){setShowGpick(false);setBatch(false);setChk({});storage.set('portfolio_force_refresh',true);loadData(true)}else showToast(r.msg||'失败')}catch(e:any){showToast('错误:'+e.message)}}}>{g}</div>)}
        <div style={{padding:'10px 0',borderBottom:`1px solid ${c.border}`,cursor:'pointer',color:c.textSecondary}} onClick={async()=>{try{await holdingApi.setGroup(gpCodes,'');setShowGpick(false);setBatch(false);setChk({});storage.set('portfolio_force_refresh',true);loadData(true)}catch{}}}>未分组</div>
        <div style={{padding:'10px 0',cursor:'pointer',color:c.primary}} onClick={()=>{const n=prompt('新建分组');if(n?.trim()){const gs=[...new Set([...groups,n.trim()])];setGroups(gs);storage.set('holding_groups_cache',gs);holdingApi.setGroup(gpCodes,n.trim()).catch(()=>{});setShowGpick(false);setBatch(false);setChk({})}}}>+ 新建分组</div></div></div>}

    {/* Temp Info */}
    {showTemp&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setShowTemp(false)}>
      <div style={{background:'#3A3F4B',borderRadius:12,padding:20,width:300,color:'#fff',fontSize:13,lineHeight:1.8}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>估值温度说明</div><div>基于PE历史分位计算：</div><div style={{margin:'8px 0'}}>📗 低估：PE分位&lt;25%</div><div>📙 正常：PE分位25%~75%</div><div>📕 高估：PE分位&gt;75%</div><div style={{marginTop:12,opacity:0.6}}>PE温度仅为参考，不构成投资建议</div></div></div>}

    {/* Share Card */}
    {showShare&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.5)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setShowShare(false)}>
      <div style={{background:c.cardBg,borderRadius:12,padding:16,width:320}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:15,fontWeight:600,marginBottom:12}}>分享卡片</div>
        <div style={{width:'100%',aspectRatio:'600/840',background:c.bg,borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center',color:c.textSecondary,fontSize:13}}>长按保存图片</div>
        <div style={{display:'flex',gap:12,marginTop:12}}>
          <button onClick={()=>setShowShare(false)} style={{flex:1,padding:10,borderRadius:20,border:`1px solid ${c.border}`,background:c.cardBg,fontSize:14}}>取消</button>
          <button style={{flex:1,padding:10,borderRadius:20,border:'none',background:c.primary,color:'#fff',fontSize:14}}>保存到相册</button></div></div></div>}

    {/* Alert Edit Modal */}
    {showAlert&&<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:100,display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setShowAlert(false)}>
      <div style={{background:c.cardBg,borderRadius:12,padding:20,width:300}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:15,fontWeight:600,marginBottom:12}}>设置提醒 — {showToastName}</div>
        <div style={{marginBottom:12}}><div style={{fontSize:12,color:c.textSecondary,marginBottom:4}}>上涨提醒（%）</div>
          <input value={showToastUpper} onChange={e=>setAlertUpper(e.target.value)} type="number" placeholder="如 15" style={{width:'100%',padding:'6px 10px',borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:14}}/></div>
        <div style={{marginBottom:12}}><div style={{fontSize:12,color:c.textSecondary,marginBottom:4}}>下跌提醒（%）</div>
          <input value={showToastLower} onChange={e=>setAlertLower(e.target.value)} type="number" placeholder="如 -10" style={{width:'100%',padding:'6px 10px',borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:14}}/></div>
        <div style={{marginBottom:16,display:'flex',alignItems:'center',gap:8}}>
          <input type="checkbox" checked={showToastPe} onChange={e=>setAlertPe(e.target.checked)}/>
          <span style={{fontSize:12,color:c.textSecondary}}>PE温度变化提醒</span></div>
        <button onClick={()=>{
          const s=storage.get<any>('showToastSettings')||{};
          s[showToastCode]={upper:parseFloat(showToastUpper)||0,lower:parseFloat(showToastLower)||0,peAlert:showToastPe};
          storage.set('showToastSettings',s);
          if(showToastPe){const pc=storage.get<any>('peSignalCache')||{};const h=holdings.find(x=>x.fundCode===showToastCode);if(h?.peTemp?.signal)pc[showToastCode]=h.peTemp.signal;storage.set('peSignalCache',pc);}
          setShowAlert(false);showToast('已设置提醒');
        }} style={{width:'100%',padding:10,borderRadius:20,border:'none',background:c.primary,color:'#fff',fontSize:14,cursor:'pointer'}}>保存</button></div></div>}
  </div>;
}
