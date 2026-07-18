import { useState,useEffect,useCallback,useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPortfolio,fetchMarketIndex } from '../../api';
import { useUserStore } from '../../stores/user';
import { useThemeColors } from '../../hooks/useThemeColors';
import LineChart from '../../components/Charts/LineChart';
import DualLineChart from '../../components/Charts/DualLineChart';
import { storage } from '../../stores/cache';
import calculator from '../../utils/calculator';

const CACHE='profit_detail_cache_v2';
const INDICES=[{code:'000001',name:'上证指数'},{code:'399001',name:'深证成指'},{code:'399006',name:'创业板指'},{code:'000300',name:'沪深300'}];

export default function ProfitDetailPage(){
  const c=useThemeColors();const nav=useNavigate();const {isLoggedIn}=useUserStore();
  const [loading,setLoading]=useState(true);const [loadErr,setLoadErr]=useState(false);const [empty,setEmpty]=useState(false);
  const [activeTab,setActiveTab]=useState('today');
  const [todayP,setTodayP]=useState(0);const [todayPR,setTodayPR]=useState(0);
  const [weekP,setWeekP]=useState(0);const [weekPR,setWeekPR]=useState(0);
  const [monthP,setMonthP]=useState(0);const [monthPR,setMonthPR]=useState(0);
  const [yearP,setYearP]=useState(0);const [yearPR,setYearPR]=useState(0);
  const [compareIdx,setCompareIdx]=useState('000300');
  const [chartData,setChartData]=useState<any[]>([]);
  const [chartDual,setChartDual]=useState(false);
  const [calendarView,setCalendarView]=useState('day');
  const [dayCal,setDayCal]=useState<any[][]>([]);
  const [profitMode,setProfitMode]=useState<'amount'|'rate'>('amount');
  const [earliestDate,setEarliestDate]=useState('');
  const allDailyRef=useRef<any[]>([]);
  const dcRef=useRef<Record<string,number>>({});
  const idxMapRef=useRef<Record<string,any[]>>({});

  const load=useCallback(async()=>{
    if(!isLoggedIn){setLoading(false);return}setLoading(true);setLoadErr(false);
    try{
      const now=new Date();const today=calculator.formatDate(now);
      const yearStart=`${now.getFullYear()}-01-01`;
      const calendarDays=Math.ceil((now.getTime()-new Date(yearStart).getTime())/86400000);
      const historyDays=Math.ceil(calendarDays*5/7)+10;

      const idxMap:Record<string,any[]>={};
      const tasks=INDICES.map(i=>fetchMarketIndex(i.code,historyDays).catch(()=>null));
      const [pfRes,...idxRes]=await Promise.all([getPortfolio(historyDays),...tasks]);
      INDICES.forEach((i,n)=>{idxMap[i.code]=(idxRes[n]?.data||[])});
      idxMapRef.current=idxMap;

      if(pfRes.code!==0||!pfRes.data){setLoadErr(true);setLoading(false);return}
      const d=pfRes.data;const hs=d.holdings||[];
      if(!hs.length){setEmpty(true);setLoading(false);return}

      const navMap=d.navHistoryMap||{};

      // Market value per day
      const dm:Record<string,number>={};
      hs.forEach((h:any)=>{
        let s=parseFloat(h.shares||h.amount||0);
        if(!s&&h.marketValue){const cn=h.currentNav||h.buyPrice;if(cn>0)s=parseFloat(h.marketValue)/cn}
        if(!s)return;
        (navMap[h.fundCode]||[]).forEach((x:any)=>{dm[x.date]=(dm[x.date]||0)+x.nav*s});
      });
      const allDaily=Object.entries(dm).map(([dt,v])=>({date:dt,value:+v.toFixed(2)})).sort((a,b)=>a.date.localeCompare(b.date));
      if(allDaily.length>=2){
        const lc=hs.reduce((c:number,h:any)=>c+((navMap[h.fundCode]||[]).some((x:any)=>x.date===allDaily[allDaily.length-1].date)?1:0),0);
        const pc=hs.reduce((c:number,h:any)=>c+((navMap[h.fundCode]||[]).some((x:any)=>x.date===allDaily[allDaily.length-2].date)?1:0),0);
        if(lc<pc)allDaily.pop();
      }
      allDailyRef.current=allDaily;

      // Daily change
      const dc:Record<string,number>={};
      hs.forEach((h:any)=>{
        let shares=parseFloat(h.shares||h.amount||0);
        if(!shares&&h.marketValue){const cn=h.currentNav||h.buyPrice;if(cn>0)shares=parseFloat(h.marketValue)/cn}
        if(!shares)return;
        const hist=[...(navMap[h.fundCode]||[])].reverse();
        if(hist.length<2)return;
        const sd=h.createTime?calculator.formatDate(h.createTime):null;
        for(let i=1;i<hist.length;i++){
          if(sd&&hist[i].date<sd)continue;
          const chg=(hist[i].nav-hist[i-1].nav)*shares;
          dc[hist[i].date]=(dc[hist[i].date]||0)+chg;
        }
      });
      Object.keys(dc).forEach(k=>{dc[k]=+dc[k].toFixed(2)});
      const tp=parseFloat(d.todayProfit)||0;
      const hasSnaps=(d.intradaySnapshots?.length||0)>0;
      const lastDate=allDaily.length?allDaily[allDaily.length-1].date:'';
      const isTradingDay=lastDate===today||hasSnaps;
      if(isTradingDay&&tp!==0)dc[today]=tp;
      dcRef.current=dc;

      // Period returns (market value ratio)
      const calcPR=(start:string)=>{
        let first:number|null=null,last:number|null=null;
        for(let i=0;i<allDaily.length;i++){
          if(allDaily[i].date>=start){
            if(first===null){for(let j=i-1;j>=0;j--){if(allDaily[j].date<start){first=allDaily[j].value;break}}if(first===null)first=allDaily[i].value}
            last=allDaily[i].value;
          }
        }
        if(!first||!last||first<=0)return{rate:0,amount:0};
        return{rate:+((last/first-1)*100).toFixed(2),amount:+(last-first).toFixed(2)};
      };
      const ws=calculator.formatDate(new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay()+(now.getDay()===0?-6:1)));
      const wr=calcPR(ws),mr=calcPR(`${today.slice(0,7)}-01`),yr=calcPR(yearStart);
      setTodayP(tp);setTodayPR(parseFloat(d.todayProfitRate||'0'));
      setWeekP(wr.amount);setWeekPR(wr.rate);setMonthP(mr.amount);setMonthPR(mr.rate);setYearP(yr.amount);setYearPR(yr.rate);

      const ec=hs.reduce((min:string,h:any)=>{if(!h.createTime)return min;const dt=calculator.formatDate(h.createTime);return dt<min?dt:min},"9999-99-99");
      setEarliestDate(ec==="9999-99-99"?"":ec);

      // Build calendar
      buildCalendar(dc,now);
      // Build chart
      buildChart(allDaily,idxMap['000300'],'today');

      storage.set(CACHE,{allDaily,dc,idxMap,tp,tpr:parseFloat(d.todayProfitRate||0),wr,mr,yr,ed:ec==="9999-99-99"?"":ec,ts:Date.now()});
      setLoading(false);
    }catch(e){
      console.error(e);setLoadErr(true);setLoading(false);
      const c2=storage.get<any>(CACHE);
      if(c2?.allDaily){allDailyRef.current=c2.allDaily;dcRef.current=c2.dc||{};idxMapRef.current=c2.idxMap||{};buildCalendar(c2.dc||{},new Date())}
    }
  },[isLoggedIn]);

  const buildCalendar=(dc:Record<string,number>,now:Date)=>{
    const y=now.getFullYear();const m=now.getMonth();
    const firstDay=new Date(y,m,1).getDay();
    const dim=new Date(y,m+1,0).getDate();
    const cm=`${y}-${String(m+1).padStart(2,'0')}`;
    const rows:any[][]=[[]];
    for(let i=0;i<firstDay;i++)rows[0].push({day:'',empty:true,profit:null});
    for(let d2=1;d2<=dim;d2++){
      const ds=`${cm}-${String(d2).padStart(2,'0')}`;
      const v=dc[ds]!=null?dc[ds]:null;
      const row=rows[rows.length-1];
      row.push({day:d2,empty:false,profit:v,rate:null});
      if(row.length===7){rows.push([]);}
    }
    if(rows[rows.length-1].length===0)rows.pop();
    setDayCal(rows);
  };

  const buildChart=(all:any[],idx:any[],tab:string)=>{
    const now=new Date();const today=calculator.formatDate(now);
    let st:string,ed:string;
    if(tab==='week'){
      st=calculator.formatDate(new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay()+(now.getDay()===0?-6:1)));
      const d2=new Date(st);d2.setDate(d2.getDate()+6);ed=calculator.formatDate(d2);
    }else if(tab==='month'){
      st=`${today.slice(0,7)}-01`;const[yy,mm]=st.split('-').map(Number);ed=`${today.slice(0,7)}-${String(Math.min(new Date(yy,mm,0).getDate(),now.getDate())).padStart(2,'0')}`;
    }else{st=`${now.getFullYear()}-01-01`;ed=today}

    const dates:string[]=[];
    {const[sy,sm,sd]=st.split('-').map(Number);const[ey,em,ed2]=ed.split('-').map(Number);
    const cur=new Date(sy,sm-1,sd);const end2=new Date(ey,em-1,ed2);
    while(cur<=end2){dates.push(calculator.formatDate(cur));cur.setDate(cur.getDate()+1)}}

    const pm:Record<string,number>={};all.forEach((d:any)=>{pm[d.date]=d.value});
    const im:Record<string,number>={};idx.forEach((d:any)=>{im[d.date]=d.close});
    let pb:number|null=null,ib:number|null=null;
    for(let i=all.length-1;i>=0;i--){if(all[i].date<st){pb=all[i].value;break}}
    for(let i=idx.length-1;i>=0;i--){if(idx[i].date<st){ib=idx[i].close;break}}
    if(pb===null){for(const d of dates){if(pm[d]){pb=pm[d];break}}}
    if(ib===null){for(const d of dates){if(im[d]){ib=im[d];break}}}

    const data=dates.map(d=>({
      date:d,
      baseRate:(pb&&pm[d])?+((pm[d]/pb-1)*100).toFixed(2):null,
      indexRate:(ib&&im[d])?+((im[d]/ib-1)*100).toFixed(2):null
    }));
    setChartData(data);setChartDual(ib!==null);
  };

  const handleTab=(tab:string)=>{setActiveTab(tab);buildChart(allDailyRef.current,idxMapRef.current[compareIdx]||[],tab)};
  const handleIdx=(code:string)=>{setCompareIdx(code);buildChart(allDailyRef.current,idxMapRef.current[code]||[],activeTab)};

  useEffect(()=>{load()},[load]);

  if(loading)return <div style={{display:'flex',justifyContent:'center',padding:48,color:c.textSecondary}}>加载中...</div>;
  if(loadErr)return <div style={{textAlign:'center',padding:48}}><div style={{fontSize:32,marginBottom:12}}>😵</div><div style={{color:c.textSecondary,marginBottom:12}}>加载失败</div><button onClick={()=>load()} style={{padding:'6px 24px',borderRadius:14,border:`1px solid ${c.primary}`,color:c.primary,background:'transparent'}}>重试</button></div>;
  if(empty)return <div style={{textAlign:'center',padding:48}}><div style={{fontSize:32,marginBottom:12}}>📉</div><div style={{color:c.textSecondary}}>暂无收益数据</div></div>;

  const fmt=(v:number)=>`${v>=0?'+':''}${v.toFixed(2)}`;
  const profitUp=todayP>=0;
  const dualData=chartData.filter(d=>d.baseRate!=null||d.indexRate!=null).map(d=>({date:d.date.slice(5),rateA:d.baseRate??0,rateB:d.indexRate??0}));
  const singleData=chartData.filter(d=>d.baseRate!=null).map(d=>({date:d.date.slice(5),value:d.baseRate||0}));

  return <div style={{minHeight:'100%',background:c.bg,paddingBottom:40}}>
    <div style={{padding:'10px 16px',background:c.cardBg,display:'flex'}}><span onClick={()=>nav(-1)} style={{fontSize:18,cursor:'pointer',marginRight:12}}>‹</span><span style={{fontWeight:600,fontSize:16}}>收益走势</span></div>
    {earliestDate&&<div style={{padding:'6px 16px',fontSize:11,color:c.textSecondary}}>收益自 {earliestDate} 起计，随交易日积累</div>}

    {/* Summary */}
    <div style={{margin:10,display:'flex',background:c.cardBg,borderRadius:12,overflow:'hidden',textAlign:'center'}}>
      {[{k:'today',l:'当天收益',p:todayP,pr:todayPR},{k:'week',l:'本周收益',p:weekP,pr:weekPR},{k:'month',l:'本月收益',p:monthP,pr:monthPR},{k:'year',l:'本年收益',p:yearP,pr:yearPR}].map(x=><div key={x.k} onClick={()=>handleTab(x.k)} style={{flex:1,padding:'8px 2px',cursor:'pointer',background:activeTab===x.k?c.primaryBg:c.cardBg}}><div style={{fontSize:10,color:activeTab===x.k?c.primary:c.textSecondary}}>{x.l}</div><div style={{fontSize:12,fontWeight:600,color:x.p>=0?c.up:c.down}}>{fmt(x.p)}</div><div style={{fontSize:10,color:x.pr>=0?c.up:c.down}}>{x.pr>=0?'+':''}{x.pr}%</div></div>)}
    </div>

    {/* Chart */}
    <div style={{margin:'0 10px',padding:12,background:c.cardBg,borderRadius:12}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
        <span style={{fontSize:14,fontWeight:600}}>{activeTab==='today'?'当天':activeTab==='week'?'本周':activeTab==='month'?'本月':'本年'}走势</span>
        <div style={{display:'flex',gap:4}}>
          {INDICES.filter(i=>i.code!=='000300').map(i=><span key={i.code} onClick={()=>handleIdx(i.code)} style={{fontSize:10,padding:'2px 6px',borderRadius:6,background:compareIdx===i.code?c.primaryBg:'transparent',color:compareIdx===i.code?c.primary:c.textSecondary,cursor:'pointer'}}>{i.name}</span>)}
          <span onClick={()=>handleIdx('000300')} style={{fontSize:10,padding:'2px 6px',borderRadius:6,background:compareIdx==='000300'?c.primaryBg:'transparent',color:compareIdx==='000300'?c.primary:c.textSecondary,cursor:'pointer'}}>沪深300</span>
        </div>
      </div>
      {chartDual&&dualData.length>0?<DualLineChart data={dualData} labelA="持仓" labelB="指数" height={220}/>:singleData.length>0?<LineChart data={singleData} height={220} color={profitUp?c.up:c.down} isReturn/>:<div style={{textAlign:'center',padding:32,color:c.textSecondary}}>暂无走势数据</div>}
      {activeTab!=='today'&&<div style={{fontSize:10,color:c.textSecondary,marginTop:4}}>回撤 = 从历史最高点到当前的最大跌幅，衡量最坏情况下的亏损幅度</div>}
    </div>

    {/* Calendar */}
    <div style={{margin:10}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
        <span style={{fontSize:14,fontWeight:600}}>盈亏日历</span>
        <span onClick={()=>setProfitMode(profitMode==='amount'?'rate':'amount')} style={{fontSize:11,color:c.primary,cursor:'pointer'}}>{profitMode==='amount'?'收益率':'收益金额'}</span>
      </div>
      <div style={{display:'flex',alignItems:'center',marginBottom:8}}>
        {[{k:'day',l:'日'},{k:'month',l:'月'},{k:'year',l:'年'}].map(t=><div key={t.k} onClick={()=>setCalendarView(t.k as any)} style={{padding:'4px 16px',fontSize:12,cursor:'pointer',borderBottom:calendarView===t.k?`2px solid ${c.primary}`:'2px solid transparent',color:calendarView===t.k?c.primary:c.textSecondary}}>{t.l}</div>)}
      </div>
      {calendarView==='day'&&<div style={{background:c.cardBg,borderRadius:12,padding:8}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',textAlign:'center',fontSize:10,color:c.textSecondary,marginBottom:4}}>{['日','一','二','三','四','五','六'].map(d=><div key={d}>{d}</div>)}</div>
        {dayCal.map((row,i)=><div key={i} style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',textAlign:'center'}}>{row.map((d:any,j)=><div key={j} style={{padding:'3px 0',borderRadius:4,background:!d.empty&&d.profit!=null?(d.profit>=0?c.primaryBg:c.downBg):'transparent',opacity:d.empty?0.3:1}}><div style={{fontSize:9}}>{d.day}</div>{!d.empty&&d.profit!=null&&<div style={{fontSize:8,color:d.profit>=0?c.up:c.down}}>{profitMode==='rate'?'--':(!isNaN(d.profit)?fmt(d.profit):'--')}</div>}</div>)}</div>)}
      </div>}
      {calendarView!=='day'&&<div style={{textAlign:'center',padding:24,color:c.textSecondary,background:c.cardBg,borderRadius:12}}>月/年视图开发中</div>}
    </div></div>;
}
