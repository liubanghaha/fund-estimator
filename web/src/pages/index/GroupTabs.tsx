import { useThemeColors } from '../../hooks/useThemeColors';
import { storage } from '../../stores/cache';

export default function GroupTabs({groups,activeGroup,counts,onGroupChange,onGroupsChange,onRenameGroup,onDeleteGroup}:{
  groups:string[];activeGroup:string;counts:Record<string,number>;onGroupChange:(g:string)=>void;onGroupsChange:(gs:string[])=>void;
  onRenameGroup?:(oldName:string,newName:string)=>void;onDeleteGroup?:(groupName:string)=>void
}){
  const c=useThemeColors();
  const groupNames=groups.filter((g:any)=>typeof g==='string'&&g&&g!=='all'&&g!=='ungrouped').map((g:any)=>String(g));
  const tabs=[{key:'all',label:`全部(${counts.all||0})`},{key:'ungrouped',label:`未分组(${counts.ungrouped||0})`},...groupNames.map(g=>({key:g,label:`${g}(${counts[g]||0})`}))];

  const showMenu=(g:string)=>{
    const menu=document.createElement('div');
    menu.style.cssText='position:fixed;inset:0;z-index:200;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.3)';
    const inner=document.createElement('div');
    inner.style.cssText='background:#fff;border-radius:16px 16px 0 0;padding:0;width:100%;max-width:400px';
    const addBtn=(text:string,color:string,fn:()=>void)=>{
      const btn=document.createElement('div');
      btn.textContent=text;btn.style.cssText=`padding:14px 16px;text-align:center;font-size:15px;border-bottom:1px solid #f0f0f0;cursor:pointer;color:${color}`;
      btn.onclick=()=>{menu.remove();fn()};inner.appendChild(btn);
    };
    addBtn('重命名','#333',()=>{
      const n=prompt('新名称',g);if(n?.trim()&&n.trim()!==g){
        onRenameGroup?.(g,n.trim());
      }
    });
    addBtn('删除分组','#E4393C',()=>{
      if(!confirm(`确定删除「${g}」分组？组内持仓将变为未分组`))return;
      onDeleteGroup?.(g);
    });
    const cancel=document.createElement('div');
    cancel.textContent='取消';cancel.style.cssText='padding:14px 16px;text-align:center;fontSize:15px;color:#999;cursor:pointer;marginTop:4px';
    cancel.onclick=()=>menu.remove();inner.appendChild(cancel);
    menu.appendChild(inner);menu.onclick=e=>{if(e.target===menu)menu.remove()};document.body.appendChild(menu);
  };

  return <div style={{display:'flex',overflowX:'auto',gap:6,padding:'6px 12px',background:c.cardBg,margin:'0 12px',borderRadius:8,scrollbarWidth:'none'}}>
    {tabs.map(t=><div key={t.key} onClick={()=>onGroupChange(t.key)}
      onContextMenu={e=>{e.preventDefault();if(t.key!=='all'&&t.key!=='ungrouped')showMenu(t.key)}}
      style={{padding:'4px 14px',borderRadius:14,fontSize:13,whiteSpace:'nowrap',cursor:'pointer',
        background:activeGroup===t.key?c.primary:c.bg,color:activeGroup===t.key?c.cardBg:c.textSecondary,fontWeight:activeGroup===t.key?600:400}}>{t.label}</div>)}
    <div onClick={()=>{const n=prompt('新建分组');if(n?.trim()){const gs=[...new Set([...groups,n.trim()])];onGroupsChange(gs);storage.set('holding_groups_cache',gs)}}}
      style={{padding:'4px 14px',borderRadius:14,fontSize:13,whiteSpace:'nowrap',border:`1px dashed ${c.textHint}`,color:c.textSecondary,cursor:'pointer'}}>+</div></div>;
}
