"use client";

const ACTION_TAG_CLASS: Record<string, string> = {
  产品: "product",
  listing: "listing",
  Listing: "listing",
  包装: "packaging",
  运营: "ops",
  质检: "qc",
  验收: "qc",
  建议: "hint",
  规格: "product",
  结构: "product",
  差异化: "diff",
  避坑: "avoid",
  验证: "hint",
};

function resolveTagClass(tag: string) {
  if (ACTION_TAG_CLASS[tag]) return ACTION_TAG_CLASS[tag];
  const key = Object.keys(ACTION_TAG_CLASS).find(item => tag.toLowerCase().includes(item.toLowerCase()));
  return key ? ACTION_TAG_CLASS[key] : "default";
}

function parseActionSteps(raw: string): Array<{ tag: string | null; text: string }> {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text === "—") return [];

  const parts = text
    .split(/[；;]/)
    .map(item => item.trim())
    .filter(Boolean);

  return parts.map(part => {
    const match = part.match(/^([^：:]{1,12})[：:](.+)$/);
    if (match) {
      return { tag: match[1]!.trim(), text: match[2]!.trim() };
    }
    return { tag: null, text: part };
  });
}

export function ActionStepsCell({
  value,
  maxItems = 5,
}: {
  value: string;
  maxItems?: number;
}) {
  const steps = parseActionSteps(value);
  if (!steps.length) return <span className="launch-muted">—</span>;

  const visible = steps.slice(0, maxItems);
  const rest = steps.length - visible.length;

  return (
    <ul className="action-steps">
      {visible.map((step, index) => (
        <li key={`${step.tag ?? "step"}-${index}`}>
          {step.tag ? <span className={`action-tag ${resolveTagClass(step.tag)}`}>{step.tag}</span> : <span className="action-dot" />}
          <span className="action-text">{step.text}</span>
        </li>
      ))}
      {rest > 0 ? <li className="action-more">另有 {rest} 项，见完整规格书</li> : null}
    </ul>
  );
}
