import { useState,useEffect } from 'react';
import { fetchMarketIndex } from '../../api';
import { storage } from '../../stores/cache';
import { useThemeColors } from '../../hooks/useThemeColors';

const ALL_INDICES=[{code:'000001',name:'上证指数'},{code:'399001',name:'深证成指'},{code:'000300',name:'沪深300'},{code:'399006',name:'创业板指'},{code:'HSTECH',name:'恒生科技'},{code:'HSI',name:'恒生指数'},{code:'SPX',name:'标普500'},{code:'IXIC',name:'纳斯达克'}];

interface Card{name:string;code:string;price:string;change:string;changeRate:string;isUp:boolean}

export default function IndexBar({expanded,onToggle,editOpen,onEditOpen,activeIndices,onSaveIndices}:{
  expanded:boolean;onToggle:()=>void;editOpen:boolean;onEditOpen:()=>void;
  activeIndices:{code:string;name:string}[];onSaveIndices:(codes:{code:string;name:string}[])=>void
}){
  const c=useThemeColors();
  const [cards,setCards]=useState<Card[]>(activeIndices.map(i=>({...i,price:'--',change:'--',changeRate:'--',isUp:true})));
  const [selections,setSelections]=useState<Record<string,boolean>>(()=>{
    const s:Record<string,boolean>={};
    const ac=activeIndices.map(i=>i.code);
    ALL_INDICES.forEach(i=>{s[i.code]=ac.includes(i.code)});
    return s;
  });

  useEffect(()=>{
    const codesKey=activeIndices.map(i=>i.code).join(',');
    const cached=storage.get<{codes:string;cards:Card[];ts:number}>('index_cache');
    if(cached?.cards?.length&&cached.codes===codesKey&&Date.now()-cached.ts<30000){setCards(cached.cards);return}
    (async()=>{
      const nc:Card[]=activeIndices.map(i=>({...i,price:'--',change:'--',changeRate:'--',isUp:true}));
      await Promise.all(activeIndices.map(async(idx,i)=>{
        try{const res=await fetchMarketIndex(idx.code,2);const d=res?.data;
          if(d?.length>=1){const latest=d[d.length-1],prev=d.length>=2?d[d.length-2]:latest;
            const ch=+(latest.close-prev.close).toFixed(2);const cr=prev.close?+((ch/prev.close)*100).toFixed(2):0;
            nc[i]={...idx,price:latest.close.toFixed(2),change:ch>0?`+${ch}`:`${ch}`,changeRate:cr>0?`+${cr}`:`${cr}`,isUp:ch>=0}}
        }catch{}
      }));
      setCards(nc);storage.set('index_cache',{codes:codesKey,cards:nc,ts:Date.now()});
    })();
  },[]);

  const toggleSel=(code:string)=>{setSelections(p=>({...p,[code]:!p[code]}))};
  const save=()=>{
    const codes=ALL_INDICES.filter(i=>selections[i.code]);
    if(!codes.length)return;
    onSaveIndices(codes);
  };

  const cd0=cards[0]||{name:'',price:'--',change:'--',changeRate:'--',isUp:true};

  return <div style={{position:'relative',margin:'10px 12px'}}>
    {/* Expanded floating panel */}
    {!editOpen&&expanded&&<div style={{
      position:'absolute',bottom:'100%',left:0,right:0,
      background:c.cardBg,borderRadius:'10px 10px 0 0',
      boxShadow:'0 -4px 20px rgba(0,0,0,0.1)',
      padding:'12px 12px 6px',marginBottom:0,
      zIndex:20,
      animation:'slideUp 0.25s ease',
    }}>
      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:4}}>
        {cards.map(cd=><div key={cd.code} style={{flex:'1 1 30%',minWidth:100,background:cd.isUp?c.primaryBg:c.downBg,borderRadius:8,padding:8,textAlign:'center'}}>
          <div style={{fontSize:11,color:c.textSecondary}}>{cd.name}</div>
          <div style={{fontSize:14,fontWeight:600,color:cd.isUp?c.up:c.down}}>{cd.price}</div>
          <div style={{fontSize:11,color:cd.isUp?c.up:c.down}}>{cd.change} {cd.changeRate}%</div></div>)}
      </div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span onClick={e=>{e.stopPropagation();onEditOpen()}} style={{fontSize:11,color:c.textSecondary,cursor:'pointer'}}>⚙</span>
        <span onClick={onToggle} style={{color:c.textSecondary,fontSize:14,cursor:'pointer'}}>收起 ▴</span>
      </div>
    </div>}

    {/* Edit panel */}
    {editOpen&&<div style={{
      position:'absolute',bottom:'100%',left:0,right:0,
      background:c.cardBg,borderRadius:'10px 10px 0 0',
      boxShadow:'0 -4px 20px rgba(0,0,0,0.1)',
      padding:12,zIndex:20,
    }}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:8}}>
        <span style={{fontSize:12,color:c.textSecondary}}>选择显示指数</span>
        <span onClick={onEditOpen} style={{fontSize:12,color:c.primary,cursor:'pointer'}}>完成</span>
      </div>
      {ALL_INDICES.map(i=><div key={i.code} onClick={()=>toggleSel(i.code)} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 0',cursor:'pointer'}}>
        <input type="checkbox" checked={selections[i.code]} readOnly style={{accentColor:c.primary}}/>
        <span style={{fontSize:13}}>{i.name}</span></div>)}
      <button onClick={save} style={{width:'100%',marginTop:8,padding:6,borderRadius:14,border:'none',background:c.primary,color:'#fff',fontSize:13,cursor:'pointer'}}>保存</button>
    </div>}

    {/* Toggle bar */}
    <div onClick={onToggle} style={{display:'flex',alignItems:'center',padding:'8px 12px',background:c.cardBg,borderRadius:10,gap:12,cursor:'pointer'}}>
      <span style={{fontSize:12,color:c.textSecondary}}>{cd0.name}</span>
      <span style={{fontSize:14,fontWeight:600,color:cd0.isUp?c.up:c.down}}>{cd0.price}</span>
      <span style={{fontSize:12,color:cd0.isUp?c.up:c.down}}>{cd0.change}</span>
      <span style={{fontSize:12,color:cd0.isUp?c.up:c.down}}>{cd0.changeRate}%</span>
      <span style={{marginLeft:'auto',color:c.textSecondary,fontSize:14}}>{expanded?'▴':'▴'}</span>
    </div>

    <style>{`@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}`}</style>
  </div>;
}
