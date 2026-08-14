import { detectProductFamily } from "./product-family.mjs";

/** 将卖家精灵 asin_detail.features 英文化摘为中文卖点。模板必须按品类隔离，禁止滑板车句式套到灯具/家具。 */

function trimSummary(text, max = 120) {
  const value = String(text ?? "").trim();
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isMostlyChinese(text) {
  if (!text) return false;
  const chinese = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return chinese >= 8 && chinese / text.length >= 0.25;
}

function isShelfLampCopy(text) {
  return /floor lamp|shelf lamp|standing lamp|lampshade|color temperature|3000k|bookshelf lamp|etagere|nightstand with lamp|落地灯|置物架/i.test(text);
}

function localizeScooterBullet(raw, lower, body) {
  if (/led|light.?up|flash/i.test(lower)) {
    if (/deck|8 light mode|jumping|cascading|chasing/i.test(lower)) {
      return trimSummary(
        "轮组与踏板均带 LED 灯效，滚动自发光且踏板支持多种灯光模式，提升趣味与夜间可见性"
      );
    }
    if (/no batter/i.test(lower)) {
      return trimSummary("LED 发光轮随骑行自动点亮，无需电池，强化外观吸引力与安全性");
    }
    return trimSummary("全轮 LED 发光设计，骑行时自动点亮，提升儿童使用趣味与夜间可见度");
  }

  if (/grow with|adjustable handlebar|ages?\s*\d|height setting|growth journey/i.test(lower)) {
    const ages = body.match(/ages?\s*([\d–-]+)/i)?.[1]?.replace(/-/g, "–");
    const heights = body.match(/([\d.]+)\s*[-–]\s*([\d.]+)\s*inch/i);
    const load = body.match(/(\d+)\s*(?:lbs|lb|pounds)/i)?.[1];
    const steps = body.match(/(\d+)\s*different height/i)?.[1];
    let summary = steps ? `${steps}档可调手把` : "多档可调手把";
    if (heights) summary += `（约 ${heights[1]}–${heights[2]} 英寸）`;
    if (ages) summary += `，适配 ${ages} 岁`;
    if (load) summary += `，最大承重约 ${load} lb`;
    summary += "，可陪伴孩子成长";
    return trimSummary(summary);
  }

  if (/\bfold(able|ing)?\b|lightweight|carry|transport/i.test(lower)) {
    const weight = body.match(/([\d.]+)\s*lbs?/i)?.[1];
    let summary = "一键折叠设计，折叠后便于携带与收纳";
    if (weight) summary += `，整车约 ${weight} lb，重量较轻`;
    return trimSummary(summary);
  }

  if (/lean.?to.?steer|steering|balance|coordination|body weight/i.test(lower)) {
    return trimSummary(
      "Lean-to-Steer 倾斜转向，通过身体重心控制方向，帮助儿童练习平衡与协调"
    );
  }

  if (/sturdy|secure|anti.?slip|wide deck|brake|handlebar/i.test(lower)) {
    const load = body.match(/(\d+)\s*(?:lbs|lb|pounds)/i)?.[1];
    let summary = "加宽防滑踏板与稳固结构，配合灵敏脚刹与软质手把，提升骑行安全与操控";
    if (load) summary += `，最大承重约 ${load} lb`;
    return trimSummary(summary);
  }

  if (/sit or stand|removable|flip.?out seat|foot rest/i.test(lower)) {
    return trimSummary("坐骑二合一：可拆翻转座椅与脚踏，让低龄儿童从坐滑自然过渡到站立骑行");
  }

  if (/pu wheel|shock|absorption|减震/i.test(lower)) {
    return trimSummary("PU 减震轮设计，提升路面缓冲与骑行舒适度，适合低龄儿童日常玩耍");
  }

  if (/pre.?assembl|easy.?assembl|no need to assemble|unfold/i.test(lower)) {
    return trimSummary("出厂预装或一步展开，安装步骤少，家长开箱即可使用");
  }

  if (/ ASTM|EN71|certif|safety/i.test(lower)) {
    return trimSummary("通过 ASTM / EN71 等安全认证，强调结构安全与合规背书");
  }

  if (/gift|children|toddlers|kids/i.test(lower) && /scooter/i.test(lower)) {
    return trimSummary("面向儿童礼物场景，强调适龄、趣味与安全，适合作为节日或生日礼物");
  }

  return null;
}

function headingOf(raw) {
  return raw.includes(":") ? raw.split(":")[0].trim() : raw.slice(0, 48);
}

function localizeLampBullet(raw, lower, body) {
  const heading = headingOf(raw).toLowerCase();
  const kelvins = [...`${heading} ${body}`.matchAll(/(2700|3000|4000|5000|6500)\s*k/gi)].map(match => `${match[1]}K`);
  const uniqueKelvins = [...new Set(kelvins)];
  const load = body.match(/(\d+)\s*(?:pounds|lbs?|lb)/i)?.[1];
  const lumens = body.match(/(\d+)\s*-?\s*lumen/i)?.[1];
  const wattMatch = `${heading} ${body}`.match(/(\d+)\s*w\b/i);
  const watts = wattMatch && Number(wattMatch[1]) <= 20 ? wattMatch[1] : null;
  const tiers = body.match(/(\d+)\s*(?:tier|layer|shelf|shelves)/i)?.[1];

  if (/lampshade|linen shade|cloth|fabric shade|soft light|non-?glar/i.test(heading)) {
    return trimSummary("布艺/亚麻灯罩柔光不刺眼，可同时做功能照明与氛围灯");
  }

  if (/color temperature|3000k|4000k|5000k|2700k|3 cct|3-color|tri-?color|三色温/i.test(heading) || /color temperature|3000k|4000k|5000k|2700k|3 cct|3-color|tri-?color|三色温/i.test(lower)) {
    const range = uniqueKelvins.length ? uniqueKelvins.join(" / ") : "暖白 / 自然光 / 冷白";
    return trimSummary(`三色温可调（${range}），同一盏灯兼顾阅读照明与氛围光`);
  }

  if (/lampshade|linen|cloth|fabric shade|soft light|non-?glar/i.test(lower)) {
    return trimSummary("布艺/亚麻灯罩柔光不刺眼，可同时做功能照明与氛围灯");
  }

  if (/shelf|storage|display|etagere|nightstand|organizer|fiberboard|置物/i.test(lower)) {
    let summary = tiers ? `${tiers}层置物架落地灯，收纳展示书籍、相框与绿植` : "多层置物架落地灯，收纳展示与照明一体";
    if (load) summary += `，单层承重约 ${load} lb`;
    return trimSummary(summary);
  }

  if (/pull chain|pull-chain/i.test(lower)) {
    return trimSummary("拉绳开关切换色温或开关灯，操作直观，无需弯腰找开关");
  }

  if (/alexa|google home|apple homekit|smart plug/i.test(lower)) {
    return trimSummary("可搭配智能插座接入 Alexa / Google Home / HomeKit，做场景联动");
  }

  if (/\bled\b|lumen|bulb|9w|8w/i.test(lower)) {
    const parts = ["标配 LED 灯泡"];
    if (watts) parts[0] = `标配 ${watts}W LED 灯泡`;
    if (lumens) parts.push(`约 ${lumens} 流明`);
    parts.push("色温/亮度可按场景切换");
    return trimSummary(parts.join("，"));
  }

  if (/living room|bedroom|corner|office|apartment/i.test(lower)) {
    return trimSummary("适合客厅、卧室角落与办公室，占地小，可兼作边几或床头柜");
  }

  if (/assembled size|product dimensions|10\.\d.+"?\s*[lw]/i.test(lower)) {
    return trimSummary("落地灯占地约 10 英寸见方、高约 63 英寸，开敞灯罩向上出光，适合角落摆放");
  }

  return null;
}

function localizeOneBullet(text, family) {
  const raw = String(text ?? "").trim();
  if (!raw) return raw;
  if (isMostlyChinese(raw)) return trimSummary(raw);

  const lower = raw.toLowerCase();
  const body = raw.includes(":") ? raw.split(":").slice(1).join(":").trim() : raw;

  if (family === "scooter") {
    const scooter = localizeScooterBullet(raw, lower, body);
    if (scooter) return scooter;
  } else if (family === "lighting" || isShelfLampCopy(raw)) {
    const lamp = localizeLampBullet(raw, lower, body);
    if (lamp) return lamp;
  }

  return trimSummary(
    body
      .replace(/\b(the|and|with|for|your|this|that|are|is|a|an)\b/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

export function localizeSellingPoints(features, context = {}) {
  const list = (features ?? []).map(String).map(item => item.trim()).filter(Boolean);
  if (!list.length) return ["等待 Listing 内容同步后提炼"];
  const family =
    context.family === "scooter" || context.family === "lighting" || context.family === "generic"
      ? context.family
      : detectProductFamily({
          title: context.title ?? "",
          category: context.category ?? "",
          features: list,
        });
  return list.slice(0, 4).map(item => localizeOneBullet(item, family));
}
