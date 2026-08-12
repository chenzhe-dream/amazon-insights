// Listing 主辅图视觉分析备注 — ecommerce-product-image-analysis
export type ListingImageRemark = {
  remark: string;
  image_types: string[];
  confidence: "high" | "medium" | "low";
};

export const listingImageRemarksMeta = {
  source: "ecommerce-product-image-analysis",
  updatedAt: "2026-08-12",
} as const;

/** 按 ASIN 索引，数组下标 0 = 图片1（主图），1 = 图片2（辅图）… */
export const listingImageRemarks: Record<string, ListingImageRemark[]> = {
  B07VY9Q95Q: [
    {
      remark: "白底主图叠加半透明手把/座椅状态示意，突出二合一坐滑站滑切换及4档可调设计，右侧女童站立使用展示比例。",
      image_types: ["产品展示", "核心卖点", "使用方法"],
      confidence: "high",
    },
    {
      remark: "主款粉色大图配左侧绿/黄/珊瑚/紫/蓝五色缩略图，展示颜色矩阵与发光轮视觉卖点。",
      image_types: ["产品展示", "多颜色/多款式"],
      confidence: "high",
    },
    {
      remark: "户外公园场景，女童佩戴头盔护膝站立骑行，左上角品牌气泡强调儿童/幼儿适用定位。",
      image_types: ["使用场景", "人群展示", "品牌形象"],
      confidence: "high",
    },
    {
      remark: "五标注信息图，分别展示锁扣、可调手把、坐滑脚踏、加宽踏板与翻转座椅五大结构卖点。",
      image_types: ["核心卖点", "功能展示", "产品细节"],
      confidence: "high",
    },
    {
      remark: "4台并排对比图，标注64.8/69.9/78.7/86.4 cm四档高度及对应3-5至8-14岁年龄区间。",
      image_types: ["尺寸参数", "性能参数"],
      confidence: "high",
    },
    {
      remark: "左生活照右轮部特写，强调滚动时全轮多色LED同步点亮，突出夜间/趣味视觉卖点。",
      image_types: ["灯光/视觉效果", "使用效果"],
      confidence: "high",
    },
    {
      remark: "倾斜转向机制圆图配合男童骑行生活照，说明通过身体倾斜控制方向以训练平衡与协调。",
      image_types: ["功能展示", "使用方法"],
      confidence: "high",
    },
    {
      remark: "暖光户外步道父子同行场景，男童骑行发光轮滑板车，强调亲子陪伴与品牌生活方式表达。",
      image_types: ["使用场景", "生活方式"],
      confidence: "high",
    },
  ],
  B0BPXRVWYK: [
    {
      remark: "白底主图前景展开态、后景折叠态并列，展示折叠收纳能力及发光轮视觉特征。",
      image_types: ["产品展示", "折叠/收纳"],
      confidence: "high",
    },
    {
      remark: "4档高度并排对比图，标注59/72/77/83 cm及对应3-4至9-10岁，附旋转锁扣操作特写。",
      image_types: ["尺寸参数", "性能参数"],
      confidence: "high",
    },
    {
      remark: "四标注信息图，分别展示TPR防滑握把、加宽踏板、脚刹操作与LED PU闪光轮四大安全结构。",
      image_types: ["产品细节", "功能展示"],
      confidence: "high",
    },
    {
      remark: "倾斜转向设计图，左右圆图展示前轮随身体倾斜转向，配合草地骑行生活照强调平衡训练。",
      image_types: ["功能展示", "使用方法"],
      confidence: "high",
    },
    {
      remark: "两步折叠示意图配合男童拉行生活照，标注2.8kg重量，强调儿童可独立携带收纳。",
      image_types: ["折叠/收纳", "使用方法"],
      confidence: "high",
    },
    {
      remark: "加宽轮卖点图，标注后轮宽5cm/2in，背景对比普通窄轮竞品，强调新手更安全稳定。",
      image_types: ["产品对比", "性能参数"],
      confidence: "high",
    },
    {
      remark: "圣诞主题边框包裹的户外骑行生活照，男童佩戴头盔，强调LED轮与节日送礼场景。",
      image_types: ["使用场景", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "白底三视图尺寸标注图，覆盖手把四档高度、轮距轮径及折叠态，右下角标注110lb最大承重。",
      image_types: ["尺寸参数", "结构展示"],
      confidence: "high",
    },
  ],
  B07DYG1C9B: [
    {
      remark: "白底主图左正侧右底部双视角，展示LED发光轮、底部金属加强板及双后轮稳定结构。",
      image_types: ["产品展示", "结构展示"],
      confidence: "high",
    },
    {
      remark: "前后轮特写图，突出前轮多色LED闪光效果、后轮双轮布局及脚刹结构。",
      image_types: ["产品细节", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "左倾斜转向机制示意配合右公园女童骑行生活照，强调通过倾斜学习平衡与转弯。",
      image_types: ["功能展示", "使用场景"],
      confidence: "high",
    },
    {
      remark: "4台并排高度对比图，标注26/29/31/34 inch四档及3-13岁推荐年龄。",
      image_types: ["尺寸参数", "性能参数"],
      confidence: "high",
    },
    {
      remark: "展开与折叠双态展示，圆图特写pull/push两步折叠锁扣操作说明。",
      image_types: ["折叠/收纳", "操作说明"],
      confidence: "high",
    },
    {
      remark: "户外侧写生活照，女童站立骑行展示产品比例与紫蓝配色在实际场景中的表现。",
      image_types: ["使用场景", "人群展示"],
      confidence: "high",
    },
  ],
  B07S64PYMM: [
    {
      remark: "白底黑色主款大图，右侧浅蓝/黑/紫/红/粉五色缩略图展示颜色矩阵与发光轮。",
      image_types: ["产品展示", "多颜色/多款式"],
      confidence: "high",
    },
    {
      remark: "五标注信息图，覆盖防滑握把、防锈铝管、旋转锁扣、132lb承重踏板与免工具一键拆卸。",
      image_types: ["产品细节", "功能展示"],
      confidence: "high",
    },
    {
      remark: "前后轮特写图，强调全轮LED闪光、宽前轮、双后轮及加强脚刹四大轮组卖点。",
      image_types: ["产品细节", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "倾斜转向机制图，半透明ghost效果展示手把左右倾斜及对应Turn Left/Right标注。",
      image_types: ["功能展示", "使用方法"],
      confidence: "high",
    },
    {
      remark: "4档高度并排对比，标注25.5/28/30.5/33 inch及对应3-5至8+岁与身高34-52in参考值。",
      image_types: ["尺寸参数", "性能参数"],
      confidence: "high",
    },
    {
      remark: "正侧双视图尺寸标注图，覆盖手把宽11in、轮距10.2in、全长22.5in及26in手把高度等参数。",
      image_types: ["尺寸参数"],
      confidence: "high",
    },
    {
      remark: "折叠态侧视产品图，手把平放至踏板，展示紧凑收纳形态与ALLEK品牌识别。",
      image_types: ["折叠/收纳", "产品展示"],
      confidence: "high",
    },
    {
      remark: "户外道路浅景深场景图，单独展示产品三轮结构与可调手把，无人物使用。",
      image_types: ["使用场景", "产品展示"],
      confidence: "high",
    },
  ],
  B08HJ96QJ9: [
    {
      remark: "白底浅蓝主款，右侧8色缩略图展示最全颜色矩阵，强调LED发光轮视觉。",
      image_types: ["产品展示", "多颜色/多款式"],
      confidence: "high",
    },
    {
      remark: "八标注信息图，覆盖握把/合金管/高度/踏板/脚刹/免工具拆卸/LED轮/锁扣全结构拆解。",
      image_types: ["产品细节", "功能展示"],
      confidence: "high",
    },
    {
      remark: "高度三档+齿形带新设计标注，右侧本品锁扣vs竞品过时夹扣对比，强调安全升级。",
      image_types: ["尺寸参数", "产品对比"],
      confidence: "high",
    },
    {
      remark: "踏板上下双视图，展示鲨鱼鳍防滑纹、底部加强结构及22/10.5/5.25/3 inch精确尺寸。",
      image_types: ["结构展示", "尺寸参数"],
      confidence: "high",
    },
    {
      remark: "前后轮特写标注4.75/1.8in前轮与3.1/1.9in后轮尺寸，强调离心力驱动LED免电池。",
      image_types: ["产品细节", "灯光/视觉效果", "性能参数"],
      confidence: "high",
    },
    {
      remark: "倾斜转向机制图，中央ghost效果+左右inset展示Turn Left/Right对应轮子偏转。",
      image_types: ["功能展示", "使用方法"],
      confidence: "high",
    },
    {
      remark: "手把从踏板一键拆卸展示图，标注INNOVATION MODEL，突出红色释放按钮与便携收纳。",
      image_types: ["折叠/收纳", "产品展示"],
      confidence: "high",
    },
  ],
  B08T8RY9VK: [
    {
      remark: "白底黑蓝主款正侧视，展示LED发光轮、PUSH高度调节按钮及TOMBUX品牌识别。",
      image_types: ["产品展示", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "4档手把高度ghost图，标注25/27/30/32 inch及对应2-4至10-12岁年龄区间。",
      image_types: ["尺寸参数", "性能参数"],
      confidence: "high",
    },
    {
      remark: "2×2对比图，本品减震弹簧+5.11in宽踏板110lb承重 vs 竞品无减震窄塑料踏板。",
      image_types: ["产品对比", "核心卖点"],
      confidence: "high",
    },
    {
      remark: "男童佩戴头盔护肘护腕护膝全套护具户外骑行，强调安全场景与产品比例。",
      image_types: ["使用场景", "人群展示"],
      confidence: "medium",
    },
    {
      remark: "低角度轮部特写，标注50mm宽轮、磁感应闪光免电池及夜间骑行可见性卖点。",
      image_types: ["灯光/视觉效果", "性能参数"],
      confidence: "high",
    },
    {
      remark: "倾斜转向机制图，ghost效果展示手把左右倾斜，说明通过身体倾斜控制方向。",
      image_types: ["功能展示", "使用方法"],
      confidence: "high",
    },
    {
      remark: "半透明脚部按压后脚刹示意图，强调渐进刹车系统可防止骑行时前倾翻倒。",
      image_types: ["功能展示", "安全提示"],
      confidence: "high",
    },
    {
      remark: "折叠态标注650×150mm尺寸，底部三步圆图展示一键释放/取出/固定手把的折叠流程。",
      image_types: ["折叠/收纳", "尺寸参数"],
      confidence: "high",
    },
  ],
  B09V5RW2VK: [
    {
      remark: "白底主图全车LED点亮，展示前轮/手把/前部灯条多区发光及紫蓝Frozen主题配色。",
      image_types: ["产品展示", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "俯拍踏板特写，展示Elsa线稿图案、Disney Frozen II授权标识及防滑砂纸纹理。",
      image_types: ["产品细节", "品牌形象"],
      confidence: "high",
    },
    {
      remark: "正面视角展示前部弧形灯条、手把LED指示灯及前轮发光效果，突出科技感灯光设计。",
      image_types: ["产品展示", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "正侧面产品图，左上角Disney logo，展示侧面轮廓、LED轮及几何图案手把。",
      image_types: ["产品展示", "品牌形象"],
      confidence: "high",
    },
    {
      remark: "斜侧视展示三轮全LED发光、Elsa踏板图案及紫蓝Frozen主题配色整体效果。",
      image_types: ["产品展示", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "俯拍后脚刹标注图，箭头指向紫色防滑脚刹，同时展示Elsa踏板图案。",
      image_types: ["产品细节", "安全提示"],
      confidence: "high",
    },
    {
      remark: "折叠态侧视，手把平放至踏板，全车LED仍点亮，展示紧凑收纳与灯光效果并存。",
      image_types: ["折叠/收纳", "灯光/视觉效果"],
      confidence: "high",
    },
    {
      remark: "户外公园公主装扮女童佩戴tiara头盔骑行，强调Disney授权+角色扮演+LED轮场景营销。",
      image_types: ["使用场景", "人群展示", "品牌形象"],
      confidence: "high",
    },
    {
      remark: "侧后方动态生活照，女童蓝色Elsa披风飘动骑行，强调角色扮演沉浸感与Disney品牌。",
      image_types: ["使用场景", "生活方式"],
      confidence: "high",
    },
  ],
};

export function getListingImageRemark(asin: string, slotIndex: number): ListingImageRemark | null {
  return listingImageRemarks[asin]?.[slotIndex] ?? null;
}
