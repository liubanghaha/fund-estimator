import { useState,useEffect,useCallback } from 'react';

let showFn:((msg:string,duration?:number)=>void)|null=null;

export function showToast(msg:string,duration=1500){
  showFn?.(msg,duration);
}

export function ToastProvider({children}:{children:React.ReactNode}){
  const [msg,setMsg]=useState('');const [visible,setVisible]=useState(false);

  const show=useCallback((m:string,d=1500)=>{
    setMsg(m);setVisible(true);setTimeout(()=>setVisible(false),d);
  },[]);

  useEffect(()=>{showFn=show;return()=>{showFn=null}},[show]);

  return <>
    {children}
    {visible&&<div style={{position:'fixed',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:9999,
      background:'rgba(0,0,0,0.75)',color:'#fff',padding:'10px 24px',borderRadius:20,fontSize:14,
      whiteSpace:'nowrap',pointerEvents:'none',animation:'fadeIn 0.2s ease'}}>{msg}</div>}
    <style>{`@keyframes fadeIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.9)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}`}</style>
  </>;
}
