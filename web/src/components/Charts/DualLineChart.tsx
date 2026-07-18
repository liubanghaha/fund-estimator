import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart as ELineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useThemeStore } from '../../stores/theme';

echarts.use([ELineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

interface DualLineChartProps {
  data: { date: string; rateA: number; rateB: number }[];
  labelA?: string;
  labelB?: string;
  height?: number;
}

export default function DualLineChart({
  data,
  labelA = '基金',
  labelB = '指数',
  height = 240,
}: DualLineChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    if (!chartRef.current || data.length === 0) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current);
    }

    const colors = theme === 'red'
      ? { a: '#E4393C', b: '#1976D2' }
      : { a: '#1976D2', b: '#E4393C' };

    instanceRef.current.setOption({
      grid: { top: 36, right: 12, bottom: 28, left: 52 },
      legend: {
        data: [labelA, labelB],
        top: 4,
        textStyle: { fontSize: 12, color: '#666' },
      },
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
          formatter: (v: number) => v.toFixed(1) + '%',
        },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(0,0,0,0.75)',
        borderColor: 'transparent',
        textStyle: { color: '#fff', fontSize: 12 },
      },
      series: [
        {
          name: labelA,
          type: 'line',
          data: data.map((d) => d.rateA),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors.a, width: 1.5 },
        },
        {
          name: labelB,
          type: 'line',
          data: data.map((d) => d.rateB),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors.b, width: 1.5 },
        },
      ],
    }, true);

    const handleResize = () => instanceRef.current?.resize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [data, labelA, labelB, theme]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}
