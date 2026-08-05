import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useUserStore } from '../../stores/user';

export default function LoginPage(){
  const nav=useNavigate();
  const [sp]=useSearchParams();
  const login=useUserStore(s=>s.login);
  const [input,setInput]=useState('');
  const [loading,setLoading]=useState(false);

  const handleLogin=()=>{
    const id=input.trim();
    if(!id){alert('请先粘贴小程序账号ID');return;}
    setLoading(true);
    login(id);
    const redirect=sp.get('redirect')||'/';
    nav(redirect,{replace:true});
  };

  return <div style={{minHeight:'100vh',background:'#f5f5f5',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:48}}>
    <div style={{fontSize:40,marginBottom:16}}>🌿</div>
    <div style={{fontSize:20,fontWeight:600,marginBottom:8,color:'#333'}}>仓记小簿</div>
    <div style={{fontSize:14,color:'#999',marginBottom:32}}>登录后同步你的持仓数据</div>
    <input
      value={input}
      onChange={e=>setInput(e.target.value)}
      placeholder="粘贴小程序账号ID"
      style={{width:'100%',maxWidth:300,padding:'12px 16px',borderRadius:12,border:'1px solid #ddd',outline:'none',fontSize:14,marginBottom:16,background:'#fff',boxSizing:'border-box'}}
    />
    <button onClick={handleLogin} disabled={loading} style={{width:'100%',maxWidth:300,padding:14,borderRadius:24,border:'none',background:loading?'#ccc':'linear-gradient(135deg,#E4393C,#FF6B6B)',color:'#fff',fontSize:16,fontWeight:600,cursor:loading?'default':'pointer'}}>{loading?'登录中...':'登录'}</button>
    <div style={{marginTop:20,fontSize:12,color:'#ccc',textAlign:'center',lineHeight:1.8}}>
      在小程序「我的」→「网页版登录」<br/>点击账号ID即可复制
    </div>
  </div>
}
