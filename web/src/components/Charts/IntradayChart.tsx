import { useEffect, useRef, useMemo } from 'react';
import * as echarts from 'echarts/core';
import { LineChart as ELineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useThemeStore } from '../../stores/theme';

echarts.use([ELineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

interface IntradayChartProps {
  /** fund line: { time, rate }[] */
  fundData: { time: string; rate: number }[];
  /** index line: { time, rate }[] */
  indexData: { time: string; rate: number }[];
  fundLabel?: string;
  indexLabel?: string;
  height?: number;
}

export default function IntradayChart({
  fundData,
  indexData,
  fundLabel = '基金',
  indexLabel = '指数',
  height = 220,
}: IntradayChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);
  const theme = useThemeStore((s) => s.theme);

  const timeLabels = useMemo(() => {
    const allTimes = new Set<string>();
    fundData.forEach((d) => allTimes.add(d.time));
    indexData.forEach((d) => allTimes.add(d.time));
    const sorted = Array.from(allTimes).sort();
    return sorted;
  }, [fundData, indexData]);

  const fundMap = useMemo(
    () => Object.fromEntries(fundData.map((d) => [d.time, d.rate])),
    [fundData],
  );
  const indexMap = useMemo(
    () => Object.fromEntries(indexData.map((d) => [d.time, d.rate])),
    [indexData],
  );

  useEffect(() => {
    if (!chartRef.current || timeLabels.length === 0) return;

    if (!instanceRef.current) {
      instanceRef.current = echarts.init(chartRef.current);
    }

    const colors = theme === 'red'
      ? { fund: '#E4393C', index: '#1976D2' }
      : { fund: '#1976D2', index: '#E4393C' };

    instanceRef.current.setOption({
      grid: { top: 32, right: 12, bottom: 12, left: 48 },
      legend: {
        data: [fundLabel, indexLabel],
        top: 4,
        textStyle: { fontSize: 11, color: '#666' },
      },
      xAxis: {
        type: 'category',
        data: timeLabels,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#999',
          fontSize: 9,
          interval: Math.max(Math.floor(timeLabels.length / 6) - 1, 0),
        },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: '#f0f0f0' } },
        axisLabel: {
          color: '#999',
          fontSize: 10,
          formatter: (v: number) => v.toFixed(2) + '%',
        },
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(0,0,0,0.75)',
        borderColor: 'transparent',
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params: unknown) => {
          const items = params as { seriesName: string; value: number; axisValue: string }[];
          let result = items[0].axisValue + '<br/>';
          items.forEach((item) => {
            const v = item.value ?? 0;
            const sign = v >= 0 ? '+' : '';
            result += `${item.seriesName}: ${sign}${v.toFixed(2)}%<br/>`;
          });
          return result;
        },
      },
      series: [
        {
          name: fundLabel,
          type: 'line',
          data: timeLabels.map((t) => fundMap[t] ?? null),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors.fund, width: 2 },
          connectNulls: false,
        },
        {
          name: indexLabel,
          type: 'line',
          data: timeLabels.map((t) => indexMap[t] ?? null),
          smooth: true,
          symbol: 'none',
          lineStyle: { color: colors.index, width: 1.5, type: 'dashed' },
          connectNulls: false,
        },
      ],
    }, true);

    const handleResize = () => instanceRef.current?.resize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [timeLabels, fundMap, indexMap, fundLabel, indexLabel, theme]);

  return <div ref={chartRef} style={{ width: '100%', height }} />;
}
