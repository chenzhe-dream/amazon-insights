/**
 * 在 Amazon 商品页 Alexa/Rufus 输入框执行七问，展开报告并提取正文。
 * 供 Playwright page.evaluate 或 CDP 环境调用。
 */

export function submitAlexaVocQuestion(prompt) {
  const question =
    prompt ??
    "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。";

  const input = document.getElementById("dpx-rex-nile-search-text-input");
  if (!input) return { ok: false, error: "Alexa input not found" };

  input.scrollIntoView({ block: "center", behavior: "instant" });
  input.focus();
  input.value = question;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  const submit =
    document.getElementById("dpx-rex-nile-submit-button-announce") ??
    document.getElementById("dpx-rex-nile-submit-button") ??
    input.closest("form")?.querySelector("button[type='submit']");

  if (submit) {
    submit.click();
  } else {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }

  return { ok: true, submitted: true };
}

export function findAlexaReportRoot() {
  const candidates = [...document.querySelectorAll("div, section, article")].filter(el => {
    const text = el.innerText ?? "";
    return text.includes("顾客洞察完整分析") && text.includes("1️⃣");
  });
  if (!candidates.length) return null;
  const sized = candidates
    .map(el => ({ el, len: el.innerText.length }))
    .filter(item => item.len >= 250 && item.len <= 45000)
    .sort((a, b) => b.len - a.len);
  return sized[0]?.el ?? candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0];
}

export function expandAlexaReport(root) {
  const scope = root ?? findAlexaReportRoot();
  if (!scope) return 0;
  scope.scrollIntoView({ block: "nearest", behavior: "instant" });
  let clicks = 0;
  for (let round = 0; round < 12; round += 1) {
    let clicked = false;
    for (const el of scope.querySelectorAll("button, a, span, div[role='button']")) {
      const text = (el.textContent ?? "").trim();
      if (
        text === "... See more" ||
        text === "See more" ||
        text === "查看更多" ||
        text === "... 查看更多" ||
        /^\.{3}\s*See more$/i.test(text)
      ) {
        el.click();
        clicks += 1;
        clicked = true;
      }
    }
    if (!clicked) break;
  }
  return clicks;
}

export function readAlexaVocReport(asinHint) {
  function findAlexaReportRoot() {
    const candidates = [...document.querySelectorAll("div, section, article")].filter(el => {
      const text = el.innerText ?? "";
      return text.includes("顾客洞察完整分析") && text.includes("1️⃣");
    });
    if (!candidates.length) return null;
    const sized = candidates
      .map(el => ({ el, len: el.innerText.length }))
      .filter(item => item.len >= 250 && item.len <= 45000)
      .sort((a, b) => b.len - a.len);
    return sized[0]?.el ?? candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0];
  }

  function expandAlexaReport(root) {
    const scope = root ?? findAlexaReportRoot();
    if (!scope) return 0;
    scope.scrollIntoView({ block: "nearest", behavior: "instant" });
    let clicks = 0;
    for (let round = 0; round < 12; round += 1) {
      let clicked = false;
      for (const el of scope.querySelectorAll("button, a, span, div[role='button']")) {
        const text = (el.textContent ?? "").trim();
        if (
          text === "... See more" ||
          text === "See more" ||
          text === "查看更多" ||
          text === "... 查看更多" ||
          /^\.{3}\s*See more$/i.test(text)
        ) {
          el.click();
          clicks += 1;
          clicked = true;
        }
      }
      if (!clicked) break;
    }
    return clicks;
  }

  const body = document.body.innerText;
  expandAlexaReport();
  const root = findAlexaReportRoot();
  let source = root?.innerText ?? body;
  if (!source.includes("顾客洞察完整分析") && body.includes("顾客洞察完整分析")) {
    source = body;
  }

  const generating =
    /Alexa is generating|正在生成/i.test(source.slice(0, 1200)) &&
    !/2️⃣\s*好评点/.test(source);

  const markerMatch = source.match(/[^\n]+（([A-Z0-9]{10})） — 顾客洞察完整分析/);
  const marker = markerMatch?.[0] ?? (source.includes("顾客洞察完整分析") ? "顾客洞察完整分析" : null);
  if (!marker) return { ok: false, generating, text: "", sections: {} };

  const asin = markerMatch?.[1] ?? asinHint ?? "";
  const start = source.indexOf(marker);
  const footerMarkers = [
    "Conditions of Use",
    "📊 购买决策",
    "🎯 营销洞察",
    "Photo Storage",
  ];
  let end = source.length;
  for (const footer of footerMarkers) {
    const idx = source.indexOf(footer, start + marker.length);
    if (idx > start && idx < end) end = idx;
  }

  const text = source.slice(start, end).trim();
  const sections = {
    attention: /1️⃣\s*顾客关注点|📌\s*1\.\s*顾客关注点|顾客关注点/.test(text),
    positives: /2️⃣\s*好评点|✅\s*2\.\s*好评点|好评点/.test(text),
    negatives: /3️⃣\s*差评点|❌\s*3\.\s*差评点|差评点/.test(text),
    unmet: /4️⃣\s*未被满足|💬\s*4\.\s*未被满足|未被满足的需求/.test(text),
    audiences: /5️⃣\s*使用人群|👨‍👩‍👧‍👦\s*5\.\s*使用人群|使用人群/.test(text),
    scenarios: /6️⃣\s*使用场景|🎯\s*6\.\s*使用场景|使用场景/.test(text),
    motives: /7️⃣\s*核心购买动机|7️⃣\s*购买动机|🛒\s*7\.\s*核心购买动机|核心购买动机|购买动机/.test(text),
    overall: /8️⃣|总体结论|综合结论|📊\s*购买决策/.test(text),
  };

  return {
    ok:
      !generating &&
      text.length > 400 &&
      Boolean(sections.positives && sections.negatives && sections.scenarios),
    asin,
    generating,
    text,
    sections,
  };
}

/** @deprecated use submitAlexaVocQuestion */
export function captureAlexaVocReport(asin, prompt) {
  return submitAlexaVocQuestion(prompt);
}
