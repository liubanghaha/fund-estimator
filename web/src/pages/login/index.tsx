import { useNavigate } from 'react-router-dom';
import { useUserStore } from '../../stores/user';

export default function LoginPage(){
  const nav=useNavigate();
  const login=useUserStore(s=>s.login);

  return <div style={{minHeight:'100vh',background:'#f5f5f5',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:48}}>
    <div style={{fontSize:40,marginBottom:16}}>🌿</div>
    <div style={{fontSize:20,fontWeight:600,marginBottom:8,color:'#333'}}>韭菜养基宝</div>
    <div style={{fontSize:14,color:'#999',marginBottom:40}}>涨跌有数 · 心中有底</div>
    <button onClick={()=>{login();nav('/',{replace:true})}} style={{width:'100%',maxWidth:300,padding:14,borderRadius:24,border:'none',background:'linear-gradient(135deg,#E4393C,#FF6B6B)',color:'#fff',fontSize:16,fontWeight:600,cursor:'pointer'}}>一键登录</button>
    <div style={{marginTop:20,fontSize:12,color:'#ccc'}}>登录后可管理持仓记录</div>
  </div>
}
