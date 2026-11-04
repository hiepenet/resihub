import React, { createContext, useContext, useId } from 'react';
import {
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  Legend as RechartsLegend,
} from 'recharts';
import {
  sanitizeChartKey,
  buildChartCssVariables,
} from '../../utils/chartHelpers';

const ChartContext = createContext(null);

function useChart() {
  const context = useContext(ChartContext);
  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />');
  }
  return context;
}

export function ChartStyle({ id, config }) {
  const css = buildChartCssVariables(id, config);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

export function ChartContainer({
  id,
  className = '',
  children,
  config = {},
  ...props
}) {
  const uniqueId = useId();
  const chartId = sanitizeChartKey(
    `chart-${id || uniqueId.replace(/:/g, '')}`
  );

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={`flex justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-slate-500 [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-slate-200/70 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-slate-200 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-slate-100/80 [&_.recharts-layer]:outline-none [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none ${className}`}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsTooltip;

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
  footerFormatter,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  className = '',
}) {
  const { config } = useChart();

  if (!active || !Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const renderedLabel = hideLabel
    ? null
    : labelFormatter
      ? labelFormatter(label, payload)
      : label;

  const footerNode = footerFormatter ? footerFormatter(payload) : null;

  return (
    <div
      className={`min-w-[180px] rounded-xl border border-slate-200/90 bg-white/95 backdrop-blur-sm px-3 py-2 text-xs shadow-elevated ${className}`}
    >
      {renderedLabel ? (
        <div className="mb-1.5 font-semibold text-slate-900 border-b border-slate-100 pb-1">
          {renderedLabel}
        </div>
      ) : null}

      <div className="space-y-1">
        {payload.map((item, index) => {
          const key = `${item.dataKey || item.name || 'value'}`;
          const itemConfig =
            config?.[key] ||
            config?.[item?.payload?.key] ||
            {};
          const indicatorColor =
            item.color ||
            item?.payload?.fill ||
            itemConfig.color ||
            '#0ea5e9';
          const displayLabel =
            itemConfig.label || item.name || key;

          return (
            <div
              key={`${key}-${index}`}
              className="flex items-center justify-between gap-4 leading-snug"
            >
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                {!hideIndicator ? (
                  <span
                    className={`shrink-0 rounded-[2px] ${
                      indicator === 'dot'
                        ? 'h-2.5 w-2.5 rounded-full'
                        : indicator === 'line'
                          ? 'h-3 w-1'
                          : 'h-0 w-3 border-t-2 border-dashed'
                    }`}
                    style={{
                      backgroundColor:
                        indicator === 'dashed' ? 'transparent' : indicatorColor,
                      borderColor: indicatorColor,
                    }}
                  />
                ) : null}
                <span>{displayLabel}</span>
              </span>
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {formatter
                  ? formatter(
                      item.value,
                      displayLabel,
                      item,
                      index,
                      item.payload
                    )
                  : item.value}
              </span>
            </div>
          );
        })}
      </div>

      {footerNode ? (
        <div className="mt-1.5 pt-1.5 border-t border-slate-100 text-[11px] font-medium text-slate-600">
          {footerNode}
        </div>
      ) : null}
    </div>
  );
}

export const ChartLegend = RechartsLegend;

export function ChartLegendContent({
  payload,
  verticalAlign = 'bottom',
  hideIcon = false,
  className = '',
}) {
  const { config } = useChart();

  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const configKeys = config ? Object.keys(config) : [];
  const orderedPayload = [...payload].sort((a, b) => {
    const ka = `${a.dataKey || a.value || ''}`;
    const kb = `${b.dataKey || b.value || ''}`;
    const ia = configKeys.indexOf(ka);
    const ib = configKeys.indexOf(kb);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 ${
        verticalAlign === 'top' ? 'pb-2.5' : 'pt-2.5'
      } ${className}`}
    >
      {orderedPayload.map((item, idx) => {
        const key = `${item.dataKey || item.value || idx}`;
        const itemConfig = config?.[key] || {};
        const swatchColor = item.color || itemConfig.color || '#0ea5e9';
        const Icon = itemConfig.icon;
        return (
          <div
            key={`${key}-${idx}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600"
          >
            {!hideIcon ? (
              Icon ? (
                <Icon className="h-3.5 w-3.5 text-slate-500" />
              ) : (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: swatchColor }}
                />
              )
            ) : null}
            <span>{itemConfig.label || item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export default ChartContainer;
