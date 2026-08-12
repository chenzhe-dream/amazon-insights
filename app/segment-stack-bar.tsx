export const segmentStackColors = [
  "#3cb371",
  "#e6b422",
  "#e8873d",
  "#e05555",
  "#5dafe8",
  "#9b72d4",
  "#6bcb9a",
  "#f0923e",
  "#7a67d8",
  "#29a7c7",
  "#26a269",
  "#d45d9e",
];

export type SegmentStackPart = { value: number; label: string; color?: string };

function formatSegmentPct(value: number) {
  return value >= 10 ? `${value.toFixed(1)}%` : value >= 4 ? `${Math.round(value)}%` : value >= 1 ? `${value.toFixed(1)}%` : "";
}

export function SegmentStackBar({
  segments,
  absolute = false,
  activeLabel = null,
  onSegmentHover,
  hideSegmentTitle = false,
}: {
  segments: SegmentStackPart[];
  absolute?: boolean;
  activeLabel?: string | null;
  onSegmentHover?: (label: string | null) => void;
  hideSegmentTitle?: boolean;
}) {
  const active = segments.filter(segment => segment.value > 0.05);
  const total = active.reduce((sum, segment) => sum + segment.value, 0) || 1;
  if (!active.length) {
    return (
      <div className="segment-stack-bar segment-stack-bar-empty">
        <span>暂无数据</span>
      </div>
    );
  }

  return (
    <div className="segment-stack-bar" onMouseLeave={() => onSegmentHover?.(null)}>
      {active.map((segment, index) => {
        const pct = absolute ? segment.value : (segment.value / total) * 100;
        return (
          <span
            key={`${segment.label}-${index}`}
            className={`segment-stack-part${activeLabel === segment.label ? " active" : ""}`}
            style={{
              width: `${Math.max(absolute ? pct : pct, 0.6)}%`,
              background: segment.color ?? segmentStackColors[index % segmentStackColors.length],
            }}
            title={hideSegmentTitle ? undefined : `${segment.label} · ${pct.toFixed(1)}%`}
            onMouseEnter={() => onSegmentHover?.(segment.label)}
          >
            {formatSegmentPct(pct)}
          </span>
        );
      })}
    </div>
  );
}

export function SegmentStackHoverPanel({
  segments,
  activeLabel,
  onHover,
}: {
  segments: SegmentStackPart[];
  activeLabel: string | null;
  onHover: (label: string | null) => void;
}) {
  return (
    <div className="variant-share-hover-panel">
      {segments.map((segment, index) => (
        <div
          key={segment.label}
          className={activeLabel === segment.label ? "active" : undefined}
          onMouseEnter={() => onHover(segment.label)}
        >
          <i style={{ background: segment.color ?? segmentStackColors[index % segmentStackColors.length] }} />
          <span>{segment.label}</span>
          <strong>{segment.value.toFixed(1)}%</strong>
        </div>
      ))}
    </div>
  );
}
