"use client";

import type { BatchAsinParseResult } from "./lib/asin-batch-input";

export function BatchAsinInput({
  raw,
  result,
  onRawChange,
}: {
  raw: string;
  result: BatchAsinParseResult;
  onRawChange: (raw: string) => void;
}) {
  return (
    <div className="asin-batch-input">
      <textarea
        aria-label="批量输入 ASIN"
        value={raw}
        onChange={event => onRawChange(event.target.value)}
        placeholder={"每行一个 ASIN，也可用空格或逗号分隔\n例如：B0XXXXXXXX B0YYYYYYYY B0ZZZZZZZZ"}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
      />
      <div className="asin-batch-summary">已识别 {result.asins.length}/10 个</div>
      {result.invalid.length > 0 ? <p role="alert">格式错误：{result.invalid.join("、")}</p> : null}
      {result.duplicates.length > 0 ? <p role="alert">重复 ASIN：{result.duplicates.join("、")}</p> : null}
      {result.overflow.length > 0 ? <p role="alert">最多 10 个，超出：{result.overflow.join("、")}</p> : null}
    </div>
  );
}
