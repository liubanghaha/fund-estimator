import { useState } from 'react';import { useNavigate } from 'react-router-dom';
import { useThemeStore } from '../../stores/theme';import { useUserStore } from '../../stores/user';
import { storage } from '../../stores/cache';import { useThemeColors } from '../../hooks/useThemeColors';

export default function UserCenterPage(){
  const c=useThemeColors();const theme=useThemeStore(s=>s.theme);const toggle=useThemeStore(s=>s.toggleTheme);
  const {isLoggedIn,uid,openid,logout,bindOpenid,unbindOpenid}=useUserStore();const nav=useNavigate();
  const [showFeedback,setShowFeedback]=useState(false);
  const [fbType,setFbType]=useState('建议');const [fbText,setFbText]=useState('');
  const [showBind,setShowBind]=useState(false);const [bindInput,setBindInput]=useState('');

  return <div style={{minHeight:'100%',background:c.bg,paddingBottom:80}}>
    <div style={{padding:'20px 16px 16px',background:c.cardBg,textAlign:'center',marginBottom:10}}>
      <div style={{fontSize:40,marginBottom:8}}>🌿</div>
      <div style={{fontSize:18,fontWeight:600}}>{isLoggedIn?`用户 ${(openid||uid||'').slice(-6)}`:'未登录'}</div>
      <div style={{fontSize:13,color:c.textSecondary,marginTop:4}}>{isLoggedIn?(openid?'已关联小程序':'未关联'):'登录后可管理持仓'}</div>
      <button onClick={isLoggedIn?logout:()=>nav('/login')} style={{marginTop:10,padding:'6px 24px',borderRadius:16,border:`1px solid ${c.primary}`,background:'transparent',color:c.primary,fontSize:13,cursor:'pointer'}}>{isLoggedIn?'退出登录':'一键登录'}</button></div>

    {isLoggedIn&&<div style={{margin:'0 10px 10px',background:c.cardBg,borderRadius:12,overflow:'hidden'}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${c.bg}`,fontSize:14}}>账号关联</div>
      {openid?<>
        <div onClick={unbindOpenid} style={{padding:'12px 16px',fontSize:14,cursor:'pointer',display:'flex',justifyContent:'space-between'}}><span>解除关联</span><span style={{color:c.down,fontSize:12}}>已关联</span></div>
      </>:<>
        <div onClick={()=>setShowBind(!showBind)} style={{padding:'12px 16px',fontSize:14,cursor:'pointer',display:'flex',justifyContent:'space-between'}}><span>关联小程序</span><span style={{color:c.textSecondary,fontSize:12}}>输入ID</span></div>
        {showBind&&<div style={{padding:'0 16px 12px'}}>
          <div style={{fontSize:11,color:c.textSecondary,marginBottom:4}}>在小程序「我的」复制账号ID</div>
          <input value={bindInput} onChange={e=>setBindInput(e.target.value)} placeholder="粘贴OPENID" style={{width:'100%',padding:'6px 12px',borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:13,marginBottom:8,background:c.cardBg}}/>
          <button onClick={()=>{if(bindInput.trim()){bindOpenid(bindInput.trim());storage.remove('portfolio_cache');setShowBind(false);setBindInput('')}}} style={{padding:'6px 16px',borderRadius:14,border:'none',background:c.primary,color:'#fff',fontSize:13,cursor:'pointer'}}>确认关联</button></div>}
      </>}
    </div>}

    {isLoggedIn&&<div style={{margin:'0 10px 10px',background:c.cardBg,borderRadius:12,overflow:'hidden'}}>
      <div onClick={()=>nav('/import-data')} style={{padding:'12px 16px',fontSize:14,cursor:'pointer',display:'flex',justifyContent:'space-between',color:'#4CAF50'}}><span>📥 从小程序导入数据</span><span style={{color:c.textSecondary}}>▸</span></div>
    </div>}

    <div style={{margin:'0 10px 10px',background:c.cardBg,borderRadius:12,overflow:'hidden'}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${c.bg}`,fontSize:14}}>设置</div>
      <div onClick={()=>setShowFeedback(!showFeedback)} style={{padding:'12px 16px',borderBottom:`1px solid ${c.bg}`,fontSize:14,cursor:'pointer',display:'flex',justifyContent:'space-between'}}><span>意见反馈</span><span style={{color:c.textSecondary}}>{showFeedback?'▾':'▸'}</span></div>
      {showFeedback&&<div style={{padding:12}}>{['建议','Bug','其他'].map(t=><span key={t} onClick={()=>setFbType(t)} style={{padding:'3px 10px',borderRadius:12,fontSize:11,border:`1px solid ${fbType===t?c.primary:c.border}`,color:fbType===t?c.primary:c.textSecondary,cursor:'pointer',marginRight:6}}>{t}</span>)}
        <textarea value={fbText} onChange={e=>setFbText(e.target.value)} placeholder="描述你的意见..." maxLength={500} style={{width:'100%',padding:8,borderRadius:8,border:`1px solid ${c.border}`,outline:'none',fontSize:12,height:80,resize:'vertical',marginTop:8,background:c.cardBg}}/>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:11,color:c.textSecondary}}><span>{fbText.length}/500</span><button onClick={()=>{if(fbText.trim()){storage.set('feedback_draft',fbText);alert('感谢反馈！');setFbText('');setShowFeedback(false)}}} style={{padding:'3px 12px',borderRadius:10,border:'none',background:c.primary,color:'#fff',fontSize:11,cursor:'pointer'}}>提交</button></div></div>}
      <div onClick={toggle} style={{padding:'12px 16px',borderBottom:`1px solid ${c.bg}`,fontSize:14,cursor:'pointer',display:'flex',justifyContent:'space-between'}}><span>主题颜色</span>
        <span style={{display:'inline-block',width:40,height:22,borderRadius:11,background:theme==='red'?c.up:'#2196F3',position:'relative'}}><span style={{position:'absolute',top:2,left:theme==='red'?20:2,width:18,height:18,borderRadius:'50%',background:'#fff',transition:'0.2s'}}/></span></div>
      <div onClick={()=>{['portfolio_cache','watchlist_cache','profit_detail_cache_v2','index_cache'].forEach(k=>storage.remove(k));alert('已清理')}} style={{padding:'12px 16px',fontSize:14,color:c.textSecondary,cursor:'pointer'}}>清理缓存</div></div>

    <div style={{margin:'0 10px 10px',background:c.cardBg,borderRadius:12,overflow:'hidden'}}>
      <div onClick={()=>nav('/fund-compare')} style={{padding:'12px 16px',borderBottom:`1px solid ${c.bg}`,fontSize:14,cursor:'pointer'}}>基金对比</div>
      <div onClick={()=>nav('/correlation-matrix')} style={{padding:'12px 16px',fontSize:14,color:c.textSecondary}}>版本 2.3.0</div></div></div>;
}
