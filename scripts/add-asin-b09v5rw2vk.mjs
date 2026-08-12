import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ASIN = "B09V5RW2VK";

const catalogEntry = {
  asin: ASIN,
  brand: "Jetson",
  image: "https://m.media-amazon.com/images/I/31WHbDMbq4L._AC_US600_.jpg",
  title:
    "Jetson Character Kids Kick Scooter, LED Lights on Stem & Light-Up Wheels, Lightweight Frame, Height-Adjustable Handlebar, Lean-to-Steer System, Easy-Fold Mechanism",
  price: 58.11,
  sales: 750,
  rating: 4.8,
  reviews: 1442,
  rank: 10732,
  subRank: 37,
  rankCategory: "Sports & Outdoors",
  subRankCategory: "Kick Scooters",
  buyBoxSeller: "Amazon",
  fulfillment: "Amazon 自营配送",
  packageSize: "22 x 10.4 x 23.5 inches",
  packageWeight: "7 pounds",
  specifications: [
    "适用年龄：幼儿 / 低龄儿童",
    "特殊功能：手把可调、可折叠、发光轮、灯杆 LED",
    "最大承重：132 磅",
    "轮子数量：3个",
    "轮子材质：聚氨酯（PU）",
  ],
  launch: "2022-03-19",
  format: "Style: 3-Wheel · Color: Frozen II",
  variants: "8个变体",
  sellingPoints: [
    "Lean-to-steer 倾斜转向，低龄儿童更易上手平衡与方向控制",
    "手把高度可调 + 一键折叠，覆盖成长阶段并便于携带收纳",
    "轮组与灯杆双 LED 发光，强化夜间可见度与 IP 主题外观吸引力",
    "迪士尼冰雪奇缘 Elsa 甲板图案，礼物场景与主题联名差异化明显",
  ],
  history: [50, 100, 400, 1000, 100, 400, 300, 400, 200, 200, 100, 288],
  prices: [60.05, 62.66, 55.94, 50.14, 51.45, 44.84, 48.25, 50.88, 56.35, 58.41, 60.01, 58.75],
  ranks: [37, 37, 35, 32, 37, 38, 37, 36, 37, 37, 37, 37],
  variantShare: [],
  variantDetails: [
    { name: "Style: 3-Wheel · Color: Frozen II · B09V5RW2VK", reviews: null, share: null, launch: null },
    { name: "Style: 3-Wheel · Color: Princess Pink · B0C6FNQ6DC", reviews: null, share: null, launch: null },
    { name: "Style: 3-Wheel · Color: Little Mermaid · B0BSHGV2SG", reviews: null, share: null, launch: null },
    { name: "Style: 3-Wheel · Color: Sonic · B0CVNPN6KV", reviews: null, share: null, launch: null },
    { name: "Style: 3-Wheel · Color: Blue · B0CVNMVKQX", reviews: null, share: null, launch: null },
    { name: "Style: 3-Wheel · Color: Mickey · B0C6FMLG3L", reviews: null, share: null, launch: null },
    { name: "Style: 2-Wheel · Color: Princess · B09V5RQCJK", reviews: null, share: null, launch: null },
    { name: "Style: 2-Wheel · Color: Frozen · B0B2P3BSWS", reviews: null, share: null, launch: null },
  ],
  strengths: [
    "Lean to Steer System: Riding just got easier, simply lean to where you want to go on the handlebars",
    "Light up Scooter: Motion activated LED lights on the wheels and 7 programmed light functions in the stem",
    "Always Growing: You can easily adjust the handlebar height to modify this scooter as your child grows",
  ],
  weaknesses: ["Sorftime 评论分析同步中"],
  unmet: ["Sorftime 评论分析同步中"],
  scenarios: ["儿童户外骑行", "礼物入门", "社区与公园玩耍"],
  audiences: ["低龄儿童家庭", "主题 IP 礼物决策人"],
  keywords: [],
  traffic: { natural: 9649, sponsored: 351, recommendation: 213 },
  synced: true,
};

const sifListingEntry = {
  overview: {
    overview: {
      ad: { score: 391.54793513, ratio: 0.03505816 },
      nf: { score: 10776.97803505, ratio: 0.96494184 },
    },
    ad: {
      sp: { name: "SP(常规)", score: 308.1992857, ratio: 0.78713041 },
      recommend: { name: "SP(推荐)", score: 83.34864944, ratio: 0.21286959 },
    },
    recommend: {
      "Customers frequently viewed": {
        name: "Customers frequently viewed",
        score: 22.31061408,
        ratio: 0.26767817,
      },
      "Picks from Amazon Influencers": {
        name: "Picks from Amazon Influencers",
        score: 0.76223281,
        ratio: 0.00914511,
      },
      "Seen on social media": { name: "Seen on social media", score: 1.60885725, ratio: 0.01930274 },
      "Trending now": { name: "Trending now", score: 9.90471112, ratio: 0.11883469 },
      "From frequently shopped brands": {
        name: "From frequently shopped brands",
        score: 47.37929298,
        ratio: 0.56844704,
      },
      "4 stars and above": { name: "4 stars and above", score: 1.38294119, ratio: 0.01659224 },
    },
    total: 11168.525970186905,
    data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
  },
  structure: {
    chars: {
      dims: [
        {
          img: "https://m.media-amazon.com/images/I/51ko3ZmX4XL._AC_UL320_.jpg",
          features: ["3-Wheel", "Princess Pink"],
          sumScore: 4540.30110541,
          ratio: 0.40652644,
          val: "B0C6FNQ6DC",
        },
        {
          img: "https://m.media-amazon.com/images/I/51u8OlMll9L._AC_UL320_.jpg",
          features: ["3-Wheel", "Frozen II"],
          sumScore: 3575.16447425,
          ratio: 0.32011068,
          val: ASIN,
        },
        {
          img: "https://m.media-amazon.com/images/I/51cw7OKZGaL._AC_UL320_.jpg",
          features: ["3-Wheel", "Little Mermaid"],
          sumScore: 2189.129217,
          ratio: 0.19600879,
          val: "B0BSHGV2SG",
        },
        {
          img: "https://m.media-amazon.com/images/I/51cL7QWW75L._AC_UL320_.jpg",
          features: ["3-Wheel", "Sonic"],
          sumScore: 272.84232013,
          ratio: 0.02442957,
          val: "B0CVNPN6KV",
        },
        {
          img: "https://m.media-amazon.com/images/I/61bdsjc7UtL._AC_UL320_.jpg",
          features: ["3-Wheel", "Blue"],
          sumScore: 238.19914488,
          ratio: 0.02132772,
          val: "B0CVNMVKQX",
        },
        {
          img: "https://m.media-amazon.com/images/I/51GS2GyAHfL._AC_UL320_.jpg",
          features: ["2-Wheel", "Princess"],
          sumScore: 156.7094993,
          ratio: 0.01403135,
          val: "B09V5RQCJK",
        },
        {
          img: "https://m.media-amazon.com/images/I/61cnPz7rUeL._AC_UL320_.jpg",
          features: ["3-Wheel", "Mickey"],
          sumScore: 117.48651028,
          ratio: 0.01051943,
          val: "B0C6FMLG3L",
        },
        {
          img: "https://m.media-amazon.com/images/I/51cIT4Mm5CL._AC_UL320_.jpg",
          features: ["2-Wheel", "Frozen"],
          sumScore: 78.69369894,
          ratio: 0.00704602,
          val: "B0B2P3BSWS",
        },
      ],
      nfs: [
        { score: 4540.30110541 },
        { score: 3183.61653912 },
        { score: 2189.129217 },
        { score: 272.84232013 },
        { score: 238.19914488 },
        { score: 156.7094993 },
        { score: 117.48651028 },
        { score: 78.69369894 },
      ],
      sps: [{ score: 308.1992857 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
      recs: [{ score: 0 }, { score: 83.34864944 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
      sbs: [{ score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
      sbvs: [{ score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }, { score: 0 }],
    },
    data_notice: "Data updated through 2026-08-09 (refreshes daily, 1-day delay)",
  },
};

const variantRows = [
  ["B0C6FNQ6DC", "Style: 3-Wheel · Color: Princess Pink"],
  [ASIN, "Style: 3-Wheel · Color: Frozen II"],
  ["B0BSHGV2SG", "Style: 3-Wheel · Color: Little Mermaid"],
  ["B0CVNPN6KV", "Style: 3-Wheel · Color: Sonic"],
  ["B0CVNMVKQX", "Style: 3-Wheel · Color: Blue"],
  ["B0C6FMLG3L", "Style: 3-Wheel · Color: Mickey"],
  ["B09V5RQCJK", "Style: 2-Wheel · Color: Princess"],
  ["B0B2P3BSWS", "Style: 2-Wheel · Color: Frozen"],
].map(([asin, attribute]) => ({
  asin,
  attribute,
  reviews: asin === ASIN ? 103 : null,
  reviewShare: null,
  childSales: asin === ASIN ? 400 : null,
  salesMonth: asin === ASIN ? "2026-02" : null,
  launch: null,
  image: null,
}));

function insertCatalog() {
  const file = path.join(root, "app", "competitor-data.ts");
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(`"asin": "${ASIN}"`)) {
    console.log("[skip] catalog already has", ASIN);
    return;
  }
  const block = `,\n  ${JSON.stringify(catalogEntry, null, 2).replace(/^/gm, "  ").trim()}\n`;
  source = source.replace(/\n\];\s*$/, `${block}];`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[ok] catalog entry added");
}

function insertSifListing() {
  const file = path.join(root, "app", "sif-listing-traffic-data.ts");
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(`${ASIN}:`)) {
    console.log("[skip] sif listing already has", ASIN);
    return;
  }
  const block = `  ${ASIN}: ${JSON.stringify(sifListingEntry, null, 4).replace(/^/gm, "  ")},\n`;
  source = source.replace(/\n};\n\nexport const sifListingTrafficOverview/, `\n${block}};\n\nexport const sifListingTrafficOverview`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[ok] sif listing traffic added");
}

function insertMonthlyTraffic() {
  const file = path.join(root, "app", "sif-monthly-traffic-trend-data.ts");
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(`${ASIN}:`)) {
    console.log("[skip] monthly traffic already has", ASIN);
    return;
  }
  const nf = [98346.64308318708, 78812.7610530831, 74423.02291730355, 75151.53961985851, 52417.3599265575, 12102.528046465108];
  const adScores = [902.4834823502395, 4746.824564472657, 8094.024660148845, 5284.8176256952775, 3560.3388997394773, 432.9391973639823];
  const entry = `  ${ASIN}: buildSeries(
    "${ASIN}",
    [...sifMonthlyTrafficMonths],
    [
${nf.map(v => `      { score: ${v} },`).join("\n")}
    ],
    [
${adScores.map(v => `      { score: ${v} },`).join("\n")}
    ],
  ),`;
  source = source.replace(/\n};\n\nexport const sifMonthlyTrafficMeta/, `\n${entry}\n};\n\nexport const sifMonthlyTrafficMeta`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[ok] monthly traffic added");
}

function insertVariantData() {
  const file = path.join(root, "app", "variant-data.ts");
  let source = fs.readFileSync(file, "utf8");
  if (source.includes(`"${ASIN}"`)) {
    console.log("[skip] variant-data already has", ASIN);
    return;
  }
  const rows = variantRows
    .map(
      row => `    {
      "asin": "${row.asin}",
      "attribute": "${row.attribute}",
      "reviews": ${row.reviews ?? "null"},
      "reviewShare": null,
      "childSales": ${row.childSales ?? "null"},
      "salesMonth": ${row.salesMonth ? `"${row.salesMonth}"` : "null"},
      "launch": null,
      "image": null
    }`
    )
    .join(",\n");
  const block = `,\n  "${ASIN}": [\n${rows}\n  ]`;
  source = source.replace(/\n};\n\s*$/, `${block}\n};\n`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[ok] variant-data added");
}

function insertRufusPending() {
  const file = path.join(root, "app", "rufus-voc-data.ts");
  let source = fs.readFileSync(file, "utf8");
  source = source.replace("6 个 ASIN 均按", "7 个 ASIN 均按");
  if (source.includes(`${ASIN}:`)) {
    console.log("[skip] rufus voc already has", ASIN);
    return;
  }
  const block = `  ${ASIN}: pendingAlexaVoc("${ASIN}", 4.8, 1442),\n`;
  source = source.replace(/\n};\n\nexport const rufusVocDimensions/, `\n${block}};\n\nexport const rufusVocDimensions`);
  fs.writeFileSync(file, source, "utf8");
  console.log("[ok] rufus voc pending stub added");
}

insertCatalog();
insertSifListing();
insertMonthlyTraffic();
insertVariantData();
insertRufusPending();
console.log("[done] static files patched for", ASIN);
