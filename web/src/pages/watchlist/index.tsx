import { useState,useEffect,useCallback,useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';
import { watchlist as wlApi,batchFetchEstimate } from '../../api';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';

interface WatchItem{fundCode:string;fundName:string;group?:string;nav?:string;estimatedNav?:string;estimatedChangeRate?:string;displayChangeRate?:number;estimateTime?:string;_checked?:boolean;_isPinned?:boolean}

const CACHE_KEY='watchlist_cache';const GROUPS_KEY='watchlist_groups_cache';const PINNED_KEY='watchlist_pinned';const POLL=10000;
function isTrading(){const n=new Date();const d=n.getDay();if(d===0||d===6)return false;const t=n.getHours()*60+n.getMinutes();return t>=570&&t<=900}

export default function WatchlistPage(){
  const c=useThemeColors();const {isLoggedIn}=useUserStore();const nav=useNavigate();
  const [items,setItems]=useState<WatchItem[]>([]);const [display,setDisplay]=useState<WatchItem[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [groups,setGroups]=useState<string[]>(storage.get<string[]>(GROUPS_KEY)||[]);
  const [activeG,setActiveG]=useState('all');
  const [pinned,setPinned]=useState<string[]>(storage.get<string[]>(PINNED_KEY)||[]);
  const [batch,setBatch]=useState(false);const [chk,setChk]=useState<Record<string,boolean>>({});
  const [sort,setSort]=useState('');const [sortO,setSortO]=useState('');
  const [kw,setKw]=useState('');const [updTime,setUpdTime]=useState('');
  const [summary,setSummary]=useState({avg:0,up:0,down:0,total:0});
  const timerRef=useRef<any>(null);const [swiping,setSwiping]=useState<string|null>(null);

  const applyF=useCallback((list:WatchItem[],g:string,k:string,p:string[],ch:Record<string,boolean>)=>{
    let f=g==='all'?list:g==='ungrouped'?list.filter(w=>!w.group):list.filter(w=>w.group===g);
    if(k){const l=k.toLowerCase();f=f.filter(w=>w.fundName.toLowerCase().includes(l)||w.fundCode.includes(l))}
    if(sort==='change')f=[...f].sort((a,b)=>{const va=a.displayChangeRate??-999;const vb=b.displayChangeRate??-999;return sortO==='asc'?va-vb:vb-va});
    else if(sort==='name')f=[...f].sort((a,b)=>a.fundName.localeCompare(b.fundName,'zh'));
    if(p.length){const pi=f.filter(w=>p.includes(w.fundCode));const r=f.filter(w=>!p.includes(w.fundCode));f=[...pi,...r]}
    return f.map(w=>({...w,_checked:!!ch[w.fundCode],_isPinned:p.includes(w.fundCode)}));
  },[sort,sortO]);

  useEffect(()=>{setDisplay(applyF(items,activeG,kw,pinned,chk))},[items,activeG,kw,pinned,chk,applyF]);

  const fetchData=useCallback(async()=>{
    try{const [lr,gr]=await Promise.all([wlApi.list(),wlApi.getGroups().catch(()=>({code:0,data:[]}))]);
      let sg:string[]=[];if(gr.code===0)sg=gr.data||[];
      const cg=storage.get<string[]>(GROUPS_KEY)||[];setGroups([...new Set([...cg,...sg])]);
      if(lr.code===0&&lr.data?.length>0){
        const raw=lr.data;const codes=raw.map((w:WatchItem)=>w.fundCode);
        const er=await batchFetchEstimate(codes).catch(()=>null);const ed=er?.data||{};
        const wl=raw.map((w:WatchItem)=>{const e=ed[w.fundCode];return {fundCode:w.fundCode,fundName:w.fundName,group:w.group||'',nav:e?.nav||null,estimatedNav:e?.estimatedNav||null,estimatedChangeRate:e?.estimatedChangeRate||null,displayChangeRate:e?.displayChangeRate||null,estimateTime:e?.estimateTime||null}});
        setItems(wl);setLoaded(true);setUpdTime(new Date().toLocaleTimeString('zh-CN',{hour12:false}));
        let up=0,down=0,sum=0,valid=0;
        wl.forEach(w=>{if(w.displayChangeRate!=null){sum+=w.displayChangeRate;valid++;if(w.displayChangeRate>0)up++;else if(w.displayChangeRate<0)down++}});
        setSummary({avg:valid?+(sum/valid).toFixed(2):0,up,down,total:valid});
        storage.set(CACHE_KEY,{watchlist:wl,groups:[...new Set([...cg,...sg])],time:Date.now()});
      }else{setItems([]);setLoaded(true)}
    }catch{setLoaded(true)}
  },[]);

  useEffect(()=>{if(!isLoggedIn)return;fetchData();
    if(!isTrading())return;
    timerRef.current=setInterval(async()=>{if(!isTrading()){clearInterval(timerRef.current!);return}
      const codes=items.map(w=>w.fundCode);if(!codes.length)return;
      try{const er=await batchFetchEstimate(codes);if(!er||er.code!==0)return;const ed=er.data||{};
        setItems(p=>p.map(w=>{const e=ed[w.fundCode];if(!e)return w;return{...w,nav:e.nav||w.nav,displayChangeRate:e.displayChangeRate??w.displayChangeRate,estimatedChangeRate:e.estimatedChangeRate??w.estimatedChangeRate,estimateTime:e.estimateTime||w.estimateTime}}));
        setUpdTime(new Date().toLocaleTimeString('zh-CN',{hour12:false}));
      }catch{}
    },POLL);
    return ()=>{if(timerRef.current)clearInterval(timerRef.current)};
  },[isLoggedIn]);

  if(!isLoggedIn)return <div style={{minHeight:'100vh',background:c.bg,display:'flex',alignItems:'center',justifyContent:'center',color:c.textSecondary}}>请先登录</div>;

  return <div style={{minHeight:'100%',background:c.bg,paddingBottom:10}}>
    <div style={{padding:'8px 12px',background:c.cardBg,display:'flex',gap:8,alignItems:'center'}}>
      <input placeholder="搜索基金" value={kw} onChange={e=>setKw(e.target.value)} style={{flex:1,padding:'6px 12px',borderRadius:16,border:`1px solid ${c.border}`,outline:'none',fontSize:14,background:c.cardBg}}/>
      <span onClick={()=>{if(!sort){setSort('change');setSortO('desc')}else if(sort==='change'&&sortO==='desc'){setSort('change');setSortO('asc')}else{setSort('name');setSortO('')}}} style={{fontSize:13,color:c.primary,cursor:'pointer',whiteSpace:'nowrap'}}>{!sort?'排序':sort==='change'?(sortO==='desc'?'涨跌↓':'涨跌↑'):'名称'}</span></div>
    <div style={{display:'flex',overflowX:'auto',gap:4,padding:'6px 12px',background:c.cardBg,scrollbarWidth:'none'}}>
      {[{key:'all',label:'全部'},{key:'ungrouped',label:'未分组'},...groups.map(g=>({key:g,label:g}))].map(t=><div key={t.key} onClick={()=>{setActiveG(t.key);setBatch(false)}} style={{padding:'4px 12px',borderRadius:14,fontSize:13,whiteSpace:'nowrap',cursor:'pointer',background:activeG===t.key?c.primary:c.bg,color:activeG===t.key?c.cardBg:c.textSecondary,fontWeight:activeG===t.key?600:400}}>{t.label}</div>)}
      <div onClick={()=>{const n=prompt('新建分组');if(n?.trim()){const gs=[...new Set([...groups,n.trim()])];setGroups(gs);storage.set(GROUPS_KEY,gs)}}} style={{padding:'4px 12px',borderRadius:14,fontSize:13,whiteSpace:'nowrap',border:`1px dashed ${c.textHint}`,color:c.textSecondary,cursor:'pointer'}}>+</div></div>
    <div style={{display:'flex',justifyContent:'space-between',padding:'6px 16px',fontSize:12,color:c.textSecondary,background:c.cardBg,margin:'0 12px',borderRadius:8}}>
      <span>共{summary.total}只</span><span>均{summary.avg>=0?'+':''}{summary.avg}%</span>
      <span style={{color:c.up}}>涨{summary.up}</span><span style={{color:c.down}}>跌{summary.down}</span>
      <span style={{color:c.primary,cursor:'pointer'}} onClick={()=>{setBatch(!batch);setChk({})}}>{batch?'完成':'批量'}</span></div>
    {batch&&<div style={{display:'flex',justifyContent:'space-between',padding:'6px 16px',background:c.primaryBg,fontSize:13,margin:'0 12px',borderRadius:8}}>
      <span onClick={()=>{const all=display.every(w=>chk[w.fundCode]);if(all)setChk({});else{const m:Record<string,boolean>={};display.forEach(w=>m[w.fundCode]=true);setChk(m)}}} style={{cursor:'pointer'}}>{display.every(w=>chk[w.fundCode])?'取消全选':'全选'}</span>
      <span style={{color:c.up,cursor:'pointer'}} onClick={async()=>{const codes=Object.keys(chk);if(!codes.length)return;if(!confirm(`删除${codes.length}个?`))return;for(const code of codes)await wlApi.remove(code).catch(()=>{});setBatch(false);setChk({});fetchData()}}>删除</span></div>}
    {!loaded?<div style={{textAlign:'center',padding:48,color:c.textSecondary}}>加载中...</div>:
    display.length===0?<div style={{textAlign:'center',padding:48,color:c.textSecondary}}>{kw?'未找到':'暂无自选'}</div>:
    display.map(w=><div key={w.fundCode} onClick={()=>batch?setChk(p=>({...p,[w.fundCode]:!p[w.fundCode]})):nav(`/fund-detail/${w.fundCode}`)}
      onTouchStart={e=>{if(batch)return;const t=e.touches[0];(e.currentTarget as any)._sx=t.clientX;(e.currentTarget as any)._sy=t.clientY}}
      onTouchMove={e=>{if(batch||!swiping&&swiping!==w.fundCode)return;const t=e.touches[0];const el=e.currentTarget as any;const dx=t.clientX-(el._sx||0);const dy=Math.abs(t.clientY-(el._sy||0));if(dy>Math.abs(dx))return;if(dx<0)setSwiping(w.fundCode);}}
      onTouchEnd={()=>{setTimeout(()=>setSwiping(null),300)}}
      style={{display:'flex',alignItems:'center',padding:'10px 16px',margin:'4px 12px',background:c.cardBg,borderRadius:10,boxShadow:'0 1px 3px rgba(0,0,0,0.03)',cursor:'pointer',position:'relative',overflow:'hidden',transform:swiping===w.fundCode?'translateX(-80px)':'none',transition:'0.2s'}}>
      {swiping===w.fundCode&&<div onClick={async(e)=>{e.stopPropagation();if(!confirm('确定删除?')){setSwiping(null);return};await wlApi.remove(w.fundCode);setSwiping(null);fetchData()}} style={{position:'absolute',right:0,top:0,bottom:0,width:80,background:c.up,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:13}}>删除</div>}
      {batch&&<input type="checkbox" checked={!!chk[w.fundCode]} readOnly style={{marginRight:8}}/>}
      <div style={{flex:1}}><div style={{fontSize:14,fontWeight:500}}>{w._isPinned?'📌 ':''}{w.fundName}</div><div style={{fontSize:11,color:c.textSecondary}}>{w.fundCode}{w.group?` · ${w.group}`:''}</div></div>
      <div style={{textAlign:'right'}}><div style={{fontSize:13,color:c.textSecondary}}>{w.nav||'--'}</div><div style={{fontSize:14,fontWeight:600,color:(w.displayChangeRate??0)>=0?c.up:c.down}}>{(w.displayChangeRate??0)>=0?'+':''}{(w.displayChangeRate)?.toFixed(2)??'--'}%</div></div></div>)}
    <div style={{textAlign:'center',padding:8,fontSize:11,color:c.textHint}}>{updTime}</div></div>;
}
