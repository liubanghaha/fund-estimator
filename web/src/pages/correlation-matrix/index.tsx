import { useState,useEffect } from 'react';import { useNavigate } from 'react-router-dom';
import { computeCorrelation,getPortfolio } from '../../api';import { useThemeColors } from '../../hooks/useThemeColors';

export default function CorrelationMatrixPage(){
  const c=useThemeColors();const nav=useNavigate();
  const [l,setL]=useState(true);const [corrData,setCorrData]=useState<any>(null);
  const [alloc,setAlloc]=useState<any>(null);
  const [hsRaw,setHs]=useState<any>(null);
  const [showAll,setShowAll]=useState(false);
  const [expanded,setExpanded]=useState<number|null>(null);
  const hs=typeof hsRaw==='number'?hsRaw:(hsRaw?.score??null);

  useEffect(()=>{(async()=>{
    try{
      const [p]=await Promise.all([getPortfolio()]);
      if(p.code===0){
        setHs(p.data?.healthScore??null);
        setAlloc(p.data?.assetAllocation||null);
        const codes=(p.data?.holdings||[]).map((h:any)=>h.fundCode).filter(Boolean);
        if(codes.length>=2){
          const cr2=await computeCorrelation({fundCodes:codes}).catch(()=>null);
          if(cr2?.code===0)setCorrData(cr2.data);
        }
      }
    }catch{}setL(false)
  })()},[]);

  const grade=hsRaw?.grade||'';const avgPE=hsRaw?.avgNormPE;
  const peLabel=avgPE!=null?(avgPE<0.7?'低估':avgPE<1.3?'正常':'高估'):'';
  const sharedStocks=corrData?.sharedStocks||[];
  const pairs=corrData?.pairs||[];
  const allocItems:any[]=alloc?.items||(alloc?Object.entries(alloc).map(([k,v])=>({industry:k,percent:v})):[]);
  const ringPct=hs!=null?Math.min(100,hs)/100:0;
  const ringColor=hs!=null?(hs>=70?c.down:hs>=40?c.mid:c.up):c.textHint;

  if(l)return <div style={{display:'flex',justifyContent:'center',padding:48,color:c.textSecondary}}>分析中...</div>;

  return <div style={{minHeight:'100vh',background:c.bg,padding:'8px 12px 40px'}}>
    <div style={{padding:'10px 0',display:'flex'}}><span onClick={()=>nav(-1)} style={{fontSize:18,cursor:'pointer',marginRight:12}}>‹</span><span style={{fontWeight:600,fontSize:16}}>资产分析</span></div>

    {/* 1. Health Score */}
    {hsRaw&&<div style={{background:c.cardBg,borderRadius:12,padding:20,marginBottom:10,boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:15,fontWeight:600,marginBottom:14}}>📊 持仓健康分</div>
      <div style={{display:'flex',alignItems:'center'}}>
        <div style={{position:'relative',width:70,height:70,flexShrink:0}}>
          <svg viewBox="0 0 36 36" style={{width:'100%',height:'100%',transform:'rotate(-90deg)'}}>
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#eee" strokeWidth="3"/>
            <circle cx="18" cy="18" r="15.9" fill="none" stroke={ringColor} strokeWidth="3" strokeDasharray={`${ringPct*100} ${100-ringPct*100}`} strokeLinecap="round"/>
          </svg>
          <span style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,fontWeight:700,color:c.primary}}>{hs}</span>
        </div>
        <div style={{flex:1,paddingLeft:16}}>
          <div style={{fontSize:15,fontWeight:600,color:grade==='优秀'?c.down:grade==='较差'?c.up:c.text}}>{grade}</div>
          <div style={{fontSize:12,color:c.textSecondary,margin:'2px 0 6px'}}>估值{peLabel} · 最大行业{hsRaw.maxIndustry}%</div>
          <div style={{marginTop:8}}>
            {[{label:'估值温度',v:hsRaw.tempScore||0},{label:'行业分散',v:hsRaw.concScore||0}].map(b=><div key={b.label} style={{display:'flex',alignItems:'center',gap:8,marginTop:4}}>
              <span style={{fontSize:11,color:c.textSecondary,width:56}}>{b.label}</span>
              <div style={{flex:1,height:8,background:c.bg,borderRadius:4,overflow:'hidden'}}><div style={{height:'100%',width:`${b.v}%`,background:c.primary,borderRadius:4,transition:'width .5s'}}/></div>
              <span style={{fontSize:11,color:c.textSecondary,width:24,textAlign:'right'}}>{b.v}</span></div>)}
          </div>
        </div>
      </div>
    </div>}

    {/* 2. Industry Penetration */}
    {allocItems.length>0&&<div style={{background:c.cardBg,borderRadius:12,padding:20,marginBottom:10,boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:15,fontWeight:600,marginBottom:14}}>🏭 行业穿透</div>
      {allocItems.slice(0,showAll?undefined:10).map((x:any)=><div key={x.industry} style={{display:'flex',alignItems:'center',padding:'6px 0',borderBottom:`1px solid ${c.bg}`}}>
        <span style={{fontSize:13,width:90,flexShrink:0}}>{x.industry}</span>
        <span style={{fontSize:12,color:c.primary,width:50,textAlign:'right',flexShrink:0}}>{x.percent}%</span>
        <div style={{flex:1,height:8,background:'#f0f0f0',borderRadius:4,overflow:'hidden',marginLeft:12}}><div style={{height:'100%',width:`${Math.min(x.percent*2,100)}%`,background:c.primary,borderRadius:4}}/></div></div>)}
      {allocItems.length>10&&<div onClick={()=>setShowAll(!showAll)} style={{textAlign:'center',padding:'8px 0',fontSize:11,color:c.textSecondary,cursor:'pointer'}}>{showAll?'收起':`展开更多（${allocItems.length-10}项）`}</div>}
    </div>}

    {/* 3. Shared Stocks */}
    {sharedStocks.length>0&&<div style={{background:c.cardBg,borderRadius:12,padding:20,marginBottom:10,boxShadow:'0 2px 12px rgba(0,0,0,0.04)'}}>
      <div style={{fontSize:15,fontWeight:600,marginBottom:14}}>🔗 持仓重合度<span style={{fontWeight:400,fontSize:11,color:c.textHint}}>（本季度前十大持仓对比）</span></div>
      <div style={{fontSize:12,color:c.textSecondary,marginBottom:8}}>重合持仓股</div>
      {sharedStocks.map((s:any,i:number)=><div key={s.stockCode}>
        <div onClick={()=>setExpanded(expanded===i?null:i)} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:`1px solid ${c.bg}`,cursor:'pointer'}}>
          <div style={{display:'flex',alignItems:'center',flex:1,minWidth:0}}>
            <span style={{fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.stockName}（{s.stockCode}）</span>
            <span style={{fontSize:10,color:c.textHint,marginLeft:6,transform:expanded===i?'rotate(180deg)':'none',transition:'0.2s',flexShrink:0}}>{expanded===i?'▼':'▶'}</span></div>
          <span style={{fontSize:11,color:c.primary,background:c.primaryBg,padding:'2px 8px',borderRadius:6,flexShrink:0,marginLeft:8}}>{s.fundCount}只基金持有</span></div>
        {expanded===i&&<div style={{margin:'4px 0 8px 8px',padding:8,background:c.bg,borderRadius:8}}>
          {s.funds.map((f:any)=><div key={f.fundCode} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:`1px solid #f0f0f0`,fontSize:12}}><span style={{color:c.textSecondary}}>{f.fundName||f.fundCode}</span><span style={{color:c.primary,fontWeight:500}}>{f.ratio}%</span></div>)}</div>}
      </div>)}
    </div>}

    {!l&&!hsRaw&&allocItems.length===0&&sharedStocks.length===0&&<div style={{textAlign:'center',padding:48,color:c.textHint}}>暂无数据</div>}
  </div>;
}
