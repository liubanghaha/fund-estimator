import { useState,useEffect } from 'react';import { useNavigate,useParams,useSearchParams } from 'react-router-dom';import { batchAddHoldings,fetchFundInfo,holding } from '../../api';import { useUserStore } from '../../stores/user';import { storage } from '../../stores/cache';import { useThemeColors } from '../../hooks/useThemeColors';

export default function AddHoldingPage(){
  const c=useThemeColors();const {fundCode:pc}=useParams<{fundCode:string}>();const [sp]=useSearchParams();const editId=sp.get('id');
  const nav=useNavigate();const {isLoggedIn}=useUserStore();
  const [code,setCode]=useState(pc||'');const [name,setName]=useState('');
  const [amount,setAmount]=useState('');const [rv,setRv]=useState('');const [rs,setRs]=useState<'+'|'-'>('+');
  const [l,setL]=useState(false);const [lu,setLu]=useState(false);
  const isEdit=!!editId;

  useEffect(()=>{if(editId){(async()=>{try{
    const r=await holding.get(editId);if(r.code===0&&r.data){
      setCode(r.data.fundCode||'');setName(r.data.fundName||'');
      setAmount(r.data.buyAmount?String(r.data.buyAmount):'');setLu(true);
      const ret=r.data.holdingReturn||0;setRs(ret>=0?'+':'-');setRv(String(Math.abs(ret||0)));
    }}catch{}})()}},[editId]);

  const lookup=async()=>{if(!code||code.length!==6)return;setL(true);try{const r=await fetchFundInfo(code);if(r.code===0&&r.data){setName(r.data.fundName||'');setLu(true)}else alert('未找到')}catch{}setL(false)};

  const save=async()=>{
    if(!isLoggedIn){nav('/login');return}if(!code||!amount){alert('请完善信息');return}setL(true);
    try{
      if(isEdit){
        const r=await holding.update(editId,{fundCode:code,fundName:name||code,amount:parseFloat(amount),return:(rs==='+'?1:-1)*parseFloat(rv||'0')});
        if(r.code===0){storage.set('portfolio_force_refresh',true);storage.remove('portfolio_cache');nav(-1)}else alert(r.msg||'失败');
      }else{
        const r=await batchAddHoldings([{fundCode:code,fundName:name||code,amount:parseFloat(amount),return:(rs==='+'?1:-1)*parseFloat(rv||'0')}]);
        if(r.code===0){storage.set('portfolio_force_refresh',true);storage.remove('portfolio_cache');nav('/',{replace:true})}else alert(r.msg||'失败');
      }
    }catch{alert('网络错误')}setL(false)};

  return <div style={{minHeight:'100vh',background:c.bg}}>
    <div style={{padding:'10px 16px',background:c.cardBg,display:'flex'}}><span onClick={()=>nav(-1)} style={{fontSize:18,cursor:'pointer',marginRight:12}}>‹</span><span style={{fontWeight:600,fontSize:16}}>{isEdit?'编辑持仓':'添加持仓'}</span></div>
    <div style={{margin:10,padding:16,background:c.cardBg,borderRadius:12}}>
      {[{l:'基金代码',v:code,on:(e:any)=>{setCode(e.target.value);setLu(false)},ph:'6位代码',max:6,dis:isEdit},{l:'申购金额（元）',v:amount,on:(e:any)=>setAmount(e.target.value),ph:'例如 1000',tp:'number'}].map(f=><div key={f.l} style={{marginBottom:12}}><div style={{fontSize:13,color:c.textSecondary,marginBottom:4}}>{f.l}</div>
        <div style={{display:'flex',gap:8}}><input value={f.v} onChange={f.on} placeholder={f.ph} maxLength={f.max} type={f.tp||'text'} disabled={f.dis} style={{flex:1,padding:'8px 12px',borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:14,background:c.cardBg}}/>
        {f.l==='基金代码'&&!isEdit&&<button onClick={lookup} disabled={l} style={{padding:'8px 16px',borderRadius:8,border:`1px solid ${c.primary}`,background:c.cardBg,color:c.primary,fontSize:13,cursor:'pointer'}}>{lu?'已识别':'查询'}</button>}</div>{f.l==='基金代码'&&name&&<div style={{marginTop:4,fontSize:14,fontWeight:500}}>{name}</div>}</div>)}
      <div style={{marginBottom:16}}><div style={{fontSize:13,color:c.textSecondary,marginBottom:4}}>持有收益（选填）</div>
        <div style={{display:'flex',gap:8}}><div style={{display:'flex',borderRadius:8,overflow:'hidden',border:`1px solid ${c.border}`}}><div onClick={()=>setRs('+')} style={{padding:'6px 14px',cursor:'pointer',background:rs==='+'?c.up:c.cardBg,color:rs==='+'?c.cardBg:c.textSecondary,fontSize:14}}>+</div><div onClick={()=>setRs('-')} style={{padding:'6px 14px',cursor:'pointer',background:rs==='-'?c.down:c.cardBg,color:rs==='-'?c.cardBg:c.textSecondary,fontSize:14}}>-</div></div><input value={rv} onChange={e=>setRv(e.target.value)} type="number" placeholder="0.00" style={{flex:1,padding:'8px 12px',borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:14}}/></div></div>
      <button onClick={save} disabled={l} style={{width:'100%',padding:12,borderRadius:24,border:'none',background:l?c.textHint:c.primary,color:c.cardBg,fontSize:16,fontWeight:600,cursor:'pointer'}}>{l?'保存中...':isEdit?'确认修改':'确认添加'}</button>
      {isEdit&&<button onClick={()=>{nav(-1)}} style={{width:'100%',padding:12,marginTop:8,borderRadius:24,border:`1px solid ${c.border}`,background:'transparent',color:c.textSecondary,fontSize:14,cursor:'pointer'}}>取消</button>}
    </div></div>;
}
