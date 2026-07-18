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
}

export default function LineChart({
  data,
  height = 200,
  color = '#E4393C',
  isReturn = false,
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
          const p = (params as { data: number; axisValue: string }[])[0];
          return `${p.axisValue}<br/>${isReturn ? '涨幅' : '净值'}: ${p.data}`;
        },
      },
      series: [
        {
          type: 'line',
          data: values,
          smooth: false,
          symbol: 'none',
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
    return () => window.removeEventListener('resize', handleResize);
  }, [data, color, isReturn]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}
