import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart as ELineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([ELineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

interface LineChartProps {
  data: { date: string; value: number }[];
  height?: number;
  color?: string;
  isReturn?: boolean;
  onTouchStart?: () => void;
  onTouchMove?: (index: number) => void;
  onTouchEnd?: () => void;
  markLine?: { value: number; label: string }[];
  txMap?: Record<string, { buys: number; sells: number }>;
}

export default function LineChart({
  data,
  height = 200,
  color = '#E4393C',
  isReturn = false,
  txMap,
}: LineChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current);
    }

    const values = data.map((d) => d.value);
    const isUp = values.length >= 2 ? values[values.length - 1] >= values[0] : true;
    const areaColor = isUp
      ? 'rgba(228, 57, 60, 0.12)'
      : 'rgba(46, 139, 87, 0.12)';

    // 构建折线数据：逐点控制 symbol，非交易点 symbol:'none'
    const lineData: any[] = data.map((d) => {
      const tx = txMap?.[d.date];
      if (!tx) return { value: d.value, symbol: 'none' };
      const isBoth = tx.buys > 0 && tx.sells > 0;
      return {
        value: d.value,
        symbol: 'circle',
        symbolSize: 5,
        itemStyle: {
          color: tx.sells > 0 && !isBoth ? '#2E8B57' : '#E4393C',
          borderColor: isBoth ? '#2E8B57' : undefined,
          borderWidth: isBoth ? 2 : 0,
        },
      };
    });

    instanceRef.current.setOption({
      grid: { top: 12, right: 12, bottom: 28, left: 52 },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#999',
          fontSize: 10,
          interval: Math.max(Math.floor(data.length / 5) - 1, 0),
          formatter: (v: string) => v.length > 5 ? v.slice(5) : v,
        },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#f0f0f0' } },
        axisLabel: {
          color: '#999',
          fontSize: 10,
          formatter: (v: number) => (isReturn ? v.toFixed(1) + '%' : v.toFixed(2)),
        },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(0,0,0,0.75)',
        borderColor: 'transparent',
        textStyle: { color: '#fff', fontSize: 12 },
        formatter: (params: unknown) => {
          const p = (params as { data: number | { value: number }; axisValue: string }[])[0];
          const v = typeof p.data === 'object' ? p.data.value : p.data;
          return `${p.axisValue}<br/>${isReturn ? '涨幅' : '净值'}: ${v}`;
        },
      },
      series: [
        {
          type: 'line',
          data: lineData,
          smooth: false,
          showAllSymbol: true,
          lineStyle: { color, width: 1.5 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: areaColor },
            { offset: 1, color: 'rgba(255,255,255,0)' },
          ]) },
        },
      ],
    }, true);

    const handleResize = () => instanceRef.current?.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [data, color, isReturn, txMap]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}
