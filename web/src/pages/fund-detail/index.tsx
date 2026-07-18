import { useState,useEffect } from 'react';
import { useParams,useNavigate } from 'react-router-dom';
import { fetchFundOverview,fetchFundProfile,fetchFundNAVHistory,watchlist,transaction } from '../../api';
import { useUserStore } from '../../stores/user';
import { useThemeColors } from '../../hooks/useThemeColors';
import LineChart from '../../components/Charts/LineChart';
import calculator from '../../utils/calculator';

export default function FundDetailPage(){
  const c=useThemeColors();const {fundCode}=useParams<{fundCode:string}>();const nav=useNavigate();const {isLoggedIn}=useUserStore();
  const [overview,setOv]=useState<any>(null);
  const [profile,setPf]=useState<any>(null);
  const [navH,setNavH]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState('trend');const [period,setPeriod]=useState(90);
  const [isFollowed,setIsFollowed]=useState(false);
  const [txList,setTxList]=useState<any[]>([]);
  const [showFee,setShowFee]=useState(false);
  const [showAllHist,setShowAllHist]=useState(false);
  const [showTx,setShowTx]=useState(true);

  useEffect(()=>{if(!fundCode)return;(async()=>{setLoading(true);
    try{const[ov,pf]=await Promise.all([fetchFundOverview(fundCode),fetchFundProfile(fundCode).catch(()=>null)]);
      if(ov.code===0){setOv(ov.data||ov);setNavH(ov.data?.history||[])}
      if(pf?.code===0)setPf(pf.data||pf);
      if(isLoggedIn){const cr=await watchlist.check(fundCode);setIsFollowed(cr.code===0&&cr.data?.exists);
        const tr=await transaction.list(fundCode);if(tr.code===0)setTxList(tr.data||[])}
    }catch{}setLoading(false)})()},[fundCode,isLoggedIn]);

  const loadNav=async(days:number)=>{setPeriod(days);try{const r=await fetchFundNAVHistory(fundCode!,days);if(r.code===0&&r.data?.length)setNavH(r.data)}catch{}}
  const ov=overview||{};const pf=profile||{};
  const isTrading=!!ov.estimatedNav;
  const navVal=ov.estimatedNav||ov.nav||ov.actualNav;
  const rate=parseFloat(String(ov.estimatedChangeRate??ov.actualChangeRate??ov.history?.[0]?.changeRate??0));
  const peT=ov.peTemp;const hist=navH;
  let maxDD:any=null,vol:any=null,sharpe:any=null;
  if(hist.length>=5)maxDD=calculator.calcMaxDrawdown(hist).drawdown;
  if(hist.length>=20){vol=calculator.calcVolatility(hist);sharpe=calculator.calcSharpe(hist)}
  const rets=hist.length>=20?calculator.calcPeriodReturns(hist):null;
  const mgr=pf.manager||{name:ov.manager||'',tenureDays:0,tenureReturn:''};
  const holdings=pf.holdings||[];
  const exited=pf.exited||[];

  if(loading)return <div style={{display:'flex',justifyContent:'center',padding:48,color:c.textSecondary}}>加载中...</div>;

  return <div style={{minHeight:'100%',background:c.bg,paddingBottom:80}}>
    {/* Header */}
    <div style={{padding:'12px 16px',background:c.cardBg,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
      <span onClick={()=>nav(-1)} style={{fontSize:18,cursor:'pointer',marginRight:12,flexShrink:0}}>‹</span>
      <div style={{flex:1,minWidth:0}}><div style={{fontSize:15,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ov.fundName||fundCode}</div><div style={{fontSize:11,color:c.textSecondary}}>{fundCode}</div></div>
      <button onClick={async()=>{try{if(isFollowed){await watchlist.remove(fundCode!);setIsFollowed(false)}else{await watchlist.add(fundCode!,ov.fundName||'');setIsFollowed(true)}}catch{}}} style={{padding:'5px 14px',borderRadius:14,border:`1px solid ${c.primary}`,background:isFollowed?c.primary:'transparent',color:isFollowed?c.cardBg:c.primary,fontSize:12,cursor:'pointer',flexShrink:0}}>{isFollowed?'已自选':'+ 加自选'}</button></div>

    {/* NAV Card */}
    <div style={{margin:10,padding:16,background:c.cardBg,borderRadius:12,borderLeft:`4px solid ${rate>=0?c.up:c.down}`}}>
      <div style={{display:'flex',justifyContent:'space-between'}}>
        <div style={{flex:1}}>
          <div style={{fontSize:12,color:c.textSecondary}}>{isTrading?'估算净值':'单位净值'}</div>
          <div style={{fontSize:28,fontWeight:700,margin:'4px 0',color:isTrading?c.text:(rate>=0?c.up:c.down)}}>{navVal?parseFloat(String(navVal)).toFixed(4):'--'}</div>
          {isTrading&&ov.nav&&<div style={{fontSize:11,color:c.textSecondary}}>昨日净值 {ov.nav}</div>}
          {!isTrading&&ov.actualDate&&<div style={{fontSize:11,color:c.textSecondary}}>净值日期：{ov.actualDate}</div>}
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:12,color:c.textSecondary}}>{isTrading?'涨幅估算':'当日涨幅'}</div>
          <div style={{fontSize:22,fontWeight:700,color:rate>=0?c.up:c.down}}>{rate>=0?'+':''}{isNaN(rate)?'--':rate.toFixed(2)}%</div>
          {isTrading&&<div style={{fontSize:10,color:c.primary,background:c.primaryBg,padding:'1px 8px',borderRadius:8,display:'inline-block',marginTop:4}}>实时数据</div>}
        </div>
      </div>
    </div>

    {/* Risk Metrics */}
    {(maxDD!=null||vol!=null||peT)&&<div style={{margin:'0 10px 10px',padding:14,background:c.cardBg,borderRadius:12}}>
      <div style={{fontSize:14,fontWeight:600,marginBottom:10}}>风险指标<span style={{fontWeight:400,fontSize:11,color:c.textSecondary}}> 近一年</span></div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        {maxDD!=null&&<div><div style={{fontSize:11,color:c.textSecondary}}>最大回撤</div><div style={{fontSize:15,fontWeight:600,color:c.up}}>{maxDD}%</div></div>}
        {vol!=null&&<div><div style={{fontSize:11,color:c.textSecondary}}>年化波动率</div><div style={{fontSize:15,fontWeight:600}}>{vol}%</div></div>}
        {sharpe!=null&&<div><div style={{fontSize:11,color:c.textSecondary}}>夏普比率</div><div style={{fontSize:15,fontWeight:600,color:sharpe>1?c.up:c.text}}>{sharpe}</div></div>}
        {peT&&peT.signal!=='nodata'&&<div><div style={{fontSize:11,color:c.textSecondary}}>估值温度 <span style={{fontSize:10}}>{peT.normPE}</span></div><div style={{fontSize:15,fontWeight:600,color:peT.signal==='low'?c.down:peT.signal==='high'?c.up:c.mid}}>{peT.label||(peT.signal==='low'?'低估':peT.signal==='high'?'高估':'正常')}</div></div>}
      </div>
    </div>}

    {/* Tabs */}
    <div style={{display:'flex',background:c.cardBg,margin:'0 10px',borderRadius:'8px 8px 0 0'}}>
      {[{k:'trend',l:'走势'},{k:'holdings',l:'持仓'},{k:'profile',l:'档案'}].map(t=><div key={t.k} onClick={()=>{setTab(t.k);if(t.k==='trend'&&hist.length===0)loadNav(period)}} style={{flex:1,textAlign:'center',padding:10,fontSize:14,color:tab===t.k?c.primary:c.textSecondary,borderBottom:tab===t.k?`2px solid ${c.primary}`:'2px solid transparent',cursor:'pointer'}}>{t.l}</div>)}
    </div>

    {/* Tab Content */}
    <div style={{margin:'0 10px',padding:16,background:c.cardBg,borderRadius:'0 0 8px 8px',minHeight:200}}>
      {tab==='trend'&&<>
        {hist.length>1&&<div style={{marginBottom:12}}>
          <div style={{fontSize:14,fontWeight:600,marginBottom:8}}>收益走势</div>
          <div style={{display:'flex',gap:8,marginBottom:8}}>{[{d:30,l:'近一月'},{d:90,l:'近三月'},{d:180,l:'近半年'},{d:365,l:'近一年'},{d:1095,l:'近三年'}].map(p=><div key={p.d} onClick={()=>loadNav(p.d)} style={{padding:'3px 12px',borderRadius:12,fontSize:12,background:period===p.d?c.primary:c.bg,color:period===p.d?c.cardBg:c.textSecondary,cursor:'pointer'}}>{p.l}</div>)}</div>
          <LineChart key={period} data={(()=>{const r=[...hist].reverse().filter((d:any)=>parseFloat(d.nav)>0);if(r.length<2)return r.map((d:any)=>({date:d.date?.slice(5)||'',value:0}));const base=r[0].nav;return r.map((d:any)=>({date:d.date?.slice(5)||'',value:+((d.nav/base-1)*100).toFixed(2)}))})()} height={200} color={rate>=0?c.up:c.down} isReturn/>
        </div>}
        {rets&&<div style={{marginBottom:12}}><div style={{fontSize:14,fontWeight:600,marginBottom:8}}>收益表现</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
            {[{k:'week',l:'近1周'},{k:'month',l:'近1月'},{k:'threeMonth',l:'近3月'},{k:'sixMonth',l:'近6月'},{k:'year',l:'近1年'},{k:'threeYear',l:'近3年'}].map(({k,l})=><div key={k} style={{textAlign:'center',padding:8,background:c.bg,borderRadius:8}}><div style={{fontSize:11,color:c.textSecondary}}>{l}</div><div style={{fontSize:14,fontWeight:600,color:(rets as any)[k]!=null?((rets as any)[k]>=0?c.up:c.down):c.textSecondary}}>{(rets as any)[k]!=null?((rets as any)[k]>=0?'+':'')+(rets as any)[k]+'%':'--'}</div></div>)}
          </div></div>}
        {hist.length>0&&<div><div style={{fontSize:14,fontWeight:600,marginBottom:8}}>历史净值</div>
          {hist.slice(0,showAllHist?undefined:10).map((d:any)=><div key={d.date} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:`1px solid ${c.bg}`,fontSize:12}}><span>{d.date}</span><span>{d.nav?.toFixed?.(4)||d.nav}</span><span style={{color:(d.changeRate||0)>=0?c.up:c.down}}>{(d.changeRate||0)>=0?'+':''}{d.changeRate}%</span></div>)}
          {hist.length>10&&<div onClick={()=>setShowAllHist(!showAllHist)} style={{textAlign:'center',padding:8,fontSize:12,color:c.primary,cursor:'pointer'}}>{showAllHist?'收起':`查看更多（共${hist.length}条）`}</div>}
        </div>}
      </>}

      {tab==='holdings'&&<>
        {holdings.length>0?<div>
          <div style={{fontSize:14,fontWeight:600,marginBottom:8}}>前十大持仓{pf.quarterLabel&&<span style={{float:'right',fontSize:11,color:c.textHint,fontWeight:400}}>{pf.quarterLabel}</span>}</div>
          <div style={{display:'flex',padding:'4px 0',fontSize:11,color:c.textSecondary,borderBottom:`1px solid ${c.bg}`}}><span style={{width:28}}>#</span><span style={{flex:1}}>名称</span><span style={{width:60,textAlign:'right'}}>今日涨跌</span><span style={{width:70,textAlign:'right'}}>调仓动向</span><span style={{width:50,textAlign:'right'}}>占比</span></div>
          {holdings.map((h:any)=><div key={h.rank} style={{display:'flex',alignItems:'center',padding:'6px 0',borderBottom:`1px solid ${c.bg}`,fontSize:12}}>
            <span style={{width:28,fontWeight:600,color:h.rank<=3?c.up:c.textSecondary}}>{h.rank}</span>
            <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.stockName}{h.isHK?<span style={{fontSize:9,border:`1px solid ${c.textSecondary}`,borderRadius:3,padding:'0 3px',marginLeft:3}}>H</span>:null}</span>
            <span style={{width:60,textAlign:'right',color:(h.stockChangeRate||0)>=0?c.up:c.down}}>{h.stockChangeRate!=null?((h.stockChangeRate>=0?'+':'')+h.stockChangeRate+'%'):'--'}</span>
            <span style={{width:70,textAlign:'right',fontSize:11,color:h.changeType==='new'?c.up:h.changeType==='up'?c.up:h.changeType==='down'?c.down:c.textSecondary}}>{h.changeType==='new'?'🆕新增':h.changeType==='up'?`📈+${h.ratioChange}%`:h.changeType==='down'?`📉${h.ratioChange}%`:'--'}</span>
            <span style={{width:50,textAlign:'right'}}>{h.navRatio||'--'}</span></div>)}
          {exited.length>0&&<div style={{marginTop:12}}>
            <div onClick={()=>setShowExited(!showExited)} style={{fontSize:12,color:c.textSecondary,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}><span>上季度退出({exited.length})</span><span style={{transform:showExited?'rotate(180deg)':'none',transition:'0.2s'}}>▾</span></div>
            {showExited&&exited.map((h:any)=><div key={h.stockCode} style={{display:'flex',alignItems:'center',padding:'5px 0',fontSize:12,opacity:0.5}}><span style={{width:28}}>{h.rank||''}</span><span style={{flex:1}}>{h.stockName}</span></div>)}
          </div>}
        </div>:<div style={{textAlign:'center',padding:32,color:c.textSecondary}}>暂无持仓数据</div>}
      </>}

      {tab==='profile'&&<>
        {mgr.name&&<div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 0',borderBottom:`1px solid ${c.bg}`,marginBottom:8}}>
          <div style={{width:36,height:36,borderRadius:'50%',background:c.primary,color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:15,fontWeight:600}}>{mgr.name[0]}</div>
          <div><div style={{fontSize:14,fontWeight:500}}>{mgr.name}</div><div style={{fontSize:11,color:c.textSecondary}}>{mgr.tenureDays?`任职${Math.round(mgr.tenureDays/365)}年`:''} {mgr.tenureReturn?`回报${mgr.tenureReturn}%`:''}</div></div></div>}
        {[['基金类型',ov.profile?.fundType],['成立日期',ov.profile?.establishDate],['基金规模',ov.profile?.fundSize?`${(ov.profile.fundSize/1e8).toFixed(1)}亿`:''],['风险等级',ov.profile?.riskLevel],['基金公司',ov.profile?.company]].filter(([,v])=>v).map(([l,v])=><div key={l} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:`1px solid ${c.bg}`,fontSize:13}}><span style={{color:c.textSecondary}}>{l}</span><span>{String(v)}</span></div>)}
        {ov.profile?.mgmtFee&&<div style={{marginTop:10}}><div onClick={()=>setShowFee(!showFee)} style={{fontSize:13,fontWeight:600,padding:'6px 0',cursor:'pointer',display:'flex',justifyContent:'space-between'}}><span>💰 费率</span><span>{showFee?'▾':'▸'}</span></div>
        {showFee&&<div style={{fontSize:12,color:c.textSecondary}}>管理费{ov.profile.mgmtFee} 托管费{ov.profile.trustFee} 销售费{ov.profile.salesFee||'0.00%'}<div style={{marginTop:4}}>长期持有费用侵蚀显著，仅供参考</div></div>}</div>}
      </>}
    </div>

    {/* Transaction Records */}
    {showTx&&txList.length>0&&<div id="tx-section" style={{margin:10,padding:12,background:c.cardBg,borderRadius:12}}>
      <div style={{fontSize:14,fontWeight:600,marginBottom:8}}>交易记录</div>
      {txList.slice(0,10).map((tx:any,i:number)=><div key={i} style={{display:'flex',alignItems:'center',padding:'4px 0',borderBottom:`1px solid ${c.bg}`,fontSize:12,gap:8}}>
        <span style={{color:tx.type==='buy'?c.up:c.down,fontWeight:600,fontSize:11,flexShrink:0}}>{tx.type==='buy'?'买入':'卖出'}</span>
        <span style={{flex:1}}>{tx.amount?`¥${tx.amount}`:''}{tx.shares?` ${tx.shares}份`:''}</span>
        <span style={{color:c.textSecondary,fontSize:11,flexShrink:0}}>{tx.date||tx.createTime?.slice(0,10)}</span></div>)}</div>}

    {/* Bottom bar */}
    <div style={{position:'fixed',bottom:0,left:0,right:0,display:'flex',background:c.cardBg,borderTop:`1px solid ${c.border}`,padding:'8px 16px',paddingBottom:'calc(8px + env(safe-area-inset-bottom))',gap:12}}>
      <button onClick={()=>nav(`/add-holding/${fundCode}`)} style={{flex:1,padding:10,borderRadius:20,border:'none',background:c.primary,color:'#fff',fontSize:13,cursor:'pointer'}}>添加持仓</button>
      <button onClick={()=>nav(`/fund-compare?b=${fundCode}`)} style={{flex:1,padding:10,borderRadius:20,border:`1px solid ${c.primary}`,background:'transparent',color:c.primary,fontSize:13,cursor:'pointer'}}>对比</button>
      <button onClick={()=>setShowTx(!showTx)} style={{flex:1,padding:10,borderRadius:20,border:`1px solid ${c.border}`,background:'transparent',color:c.textSecondary,fontSize:13,cursor:'pointer'}}>{showTx?'隐藏记录':'交易记录'}</button></div></div>;
}
