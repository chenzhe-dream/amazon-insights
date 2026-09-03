"use client";

export function HelpManual() {
  return <article className="help-manual">
    <h3>使用手册</h3>
    <section>
      <h4>快速开始</h4>
      <ol>
        <li>在左侧选择一个分析模块。</li>
        <li>输入或加载同类 ASIN。</li>
        <li>等待数据同步后查看流量、VOC、定位与产品定义结果。</li>
      </ol>
    </section>
    <section>
      <h4>提交反馈</h4>
      <p>请用一句话说明问题或建议，并补充复现步骤。</p>
      <p>可选择、拖放或粘贴最多 3 张 PNG、JPEG、WebP 图片；单张最大 5MB。</p>
    </section>
    <section>
      <h4>我的反馈</h4>
      <p>在“我的反馈”查看新反馈、处理中、已解决或已关闭状态及历史记录。</p>
    </section>
  </article>;
}
