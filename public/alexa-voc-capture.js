/**
 * Amazon 商品页书签脚本：提交 Alexa 七问、等待报告、回传团队系统并继续下一个 ASIN。
 * 由 /api/alexa-voc/bookmarklet 动态注入 vocApi / vocQueue 参数。
 */
(function amazonAlexaVocCapture() {
  if (window.__amazonAlexaVocCaptureRunning) return;
  window.__amazonAlexaVocCaptureRunning = true;

  const params = new URLSearchParams(location.search);
  const apiBase = (params.get("vocApi") || "").replace(/\/$/, "");
  const queue = (params.get("vocQueue") || "")
    .split(",")
    .map(item => item.trim().toUpperCase())
    .filter(item => /^[A-Z0-9]{10}$/.test(item));
  const currentAsin =
    location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? "";
  const prompt =
    "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。";

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:360px;padding:12px 14px;border-radius:10px;background:#0f1724;color:#eef3fb;font:12px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35)";
  panel.innerHTML = "<b>竞品 VOC 自动采集</b><div id='voc-cap-log' style='margin-top:6px;opacity:.92'></div>";
  document.body.appendChild(panel);
  const log = (text) => {
    const node = panel.querySelector("#voc-cap-log");
    if (node) node.textContent = text;
  };

  function findAlexaReportRoot() {
    const candidates = [...document.querySelectorAll("div, section, article")].filter(el => {
      const text = el.innerText ?? "";
      return (
        text.includes("顾客洞察完整分析") &&
        (text.includes("1️⃣") || text.includes("📌 1.") || text.includes("顾客关注点"))
      );
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

  function readReport(asinHint) {
    expandAlexaReport();
    const root = findAlexaReportRoot();
    let source = root?.innerText ?? document.body.innerText;
    const generating =
      /Alexa is generating|正在生成/i.test(source.slice(0, 1200)) && !/2️⃣\s*好评点|✅\s*2\.\s*好评点/.test(source);
    const markerMatch = source.match(/[^\n]+（([A-Z0-9]{10})） — 顾客洞察完整分析/);
    const marker = markerMatch?.[0] ?? (source.includes("顾客洞察完整分析") ? "顾客洞察完整分析" : null);
    if (!marker) return { ok: false, generating, text: "" };
    const start = source.indexOf(marker);
    const footers = ["Conditions of Use", "📊 购买决策", "🎯 营销洞察", "Photo Storage"];
    let end = source.length;
    for (const footer of footers) {
      const idx = source.indexOf(footer, start + marker.length);
      if (idx > start && idx < end) end = idx;
    }
    const text = source.slice(start, end).trim();
    const asin = markerMatch?.[1] ?? asinHint ?? "";
    const ok =
      !generating &&
      text.length > 400 &&
      /2️⃣\s*好评点|✅\s*2\.\s*好评点/.test(text) &&
      /3️⃣\s*差评点|❌\s*3\.\s*差评点/.test(text);
    return { ok, generating, text, asin };
  }

  function submitQuestion() {
    const input = document.getElementById("dpx-rex-nile-search-text-input");
    if (!input) return { ok: false, error: "未找到 Alexa 输入框，请确认已打开商品页且 Rufus 面板可见" };
    input.scrollIntoView({ block: "center", behavior: "instant" });
    input.focus();
    input.value = prompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const submit =
      document.getElementById("dpx-rex-nile-submit-button-announce") ??
      document.getElementById("dpx-rex-nile-submit-button") ??
      input.closest("form")?.querySelector("button[type='submit']");
    if (submit) submit.click();
    else input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    return { ok: true };
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForReport(asin) {
    const started = Date.now();
    while (Date.now() - started < 240000) {
      const report = readReport(asin);
      if (report.ok) return report;
      log(`等待 Alexa 报告… ${Math.round((Date.now() - started) / 1000)}s`);
      await wait(2500);
    }
    throw new Error("等待 Alexa 报告超时");
  }

  async function uploadReport(asin, text, autoRebuild) {
    const response = await fetch(`${apiBase}/api/alexa-voc/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asin, text, autoRebuild }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "上传失败");
    return payload;
  }

  function nextUrl(nextAsin, restQueue) {
    const nextParams = new URLSearchParams();
    nextParams.set("vocApi", apiBase);
    if (restQueue.length) nextParams.set("vocQueue", restQueue.join(","));
    nextParams.set("vocAuto", "1");
    return `https://www.amazon.com/dp/${nextAsin}?${nextParams.toString()}`;
  }

  async function run() {
    if (!apiBase) {
      log("缺少 vocApi 参数");
      return;
    }
    if (!currentAsin) {
      log("无法识别当前 ASIN");
      return;
    }

    log(`开始采集 ${currentAsin}…`);
    let report = readReport(currentAsin);
    if (!report.ok) {
      log("提交 Alexa 七问…");
      const submit = submitQuestion();
      if (!submit.ok) throw new Error(submit.error || "提交失败");
      report = await waitForReport(currentAsin);
    }

    const autoRebuild = queue.length === 0;
    log(`上传 ${currentAsin} 到系统…`);
    await uploadReport(currentAsin, report.text, autoRebuild);

    if (queue.length) {
      const [nextAsin, ...rest] = queue;
      log(`完成 ${currentAsin}，跳转 ${nextAsin}…`);
      await wait(800);
      location.href = nextUrl(nextAsin, rest);
      return;
    }

    log(`全部完成 · ${currentAsin} 已写入系统，正在构建刷新…`);
    panel.style.background = "#14532d";
    setTimeout(() => {
      if (window.opener && !window.opener.closed) {
        window.opener.location.reload();
        window.close();
      }
    }, 2500);
  }

  run().catch(error => {
    panel.style.background = "#7f1d1d";
    log(error instanceof Error ? error.message : String(error));
    window.__amazonAlexaVocCaptureRunning = false;
  });
})();
