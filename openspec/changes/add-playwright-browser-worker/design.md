## Context

现有分析链路已经把 Web 请求与持久化任务执行分离，但需要浏览器登录态的数据源仍具有不同的风险：登录可能失效，MFA 或验证码需要人工参与，会话包含高敏感秘密，浏览器进程也比普通 HTTP 连接器更容易耗尽资源。该能力因此不能作为普通分析 Worker 的一个隐式工具。

## Goals / Non-Goals

**Goals:**

- 让浏览器采集拥有独立进程、独立任务租约和独立秘密权限。
- 把人工重新认证表示为可观察的 `waiting-input`，而不是模糊失败或无限重试。
- 让浏览器采集与人工导入最终产生相同的版本化 `DataSnapshot` 契约。
- 让分析运行在浏览器能力不可用时仍可部分完成或等待输入。

**Non-Goals:**

- 本设计不实现 Worker、UI、API、数据库迁移或部署脚本。
- 不自动处理 MFA、验证码、条款确认或账号风险提示。
- 不允许 Browser Worker 直接生成分析结论或修改 AnalysisReport。
- 不复用开发者个人 Chrome 配置，不把 Playwright 嵌入 Web 进程。

## Decisions

### 1. Browser Worker 是独立部署单元

浏览器任务由持久队列派发给独立 Node/Playwright 进程。Web 和普通 Agent Worker 只读写任务协议，均不得加载浏览器会话或启动浏览器子进程。Browser Worker 使用单独的服务身份、并发上限、超时和资源配额。

### 2. 会话秘密与采集数据分离

会话状态 SHALL 使用生产秘密管理或等价的加密存储，并按组织、连接器和账号引用。任务、日志和 DataSnapshot 只保存不可逆的会话引用，不保存 Cookie、密码、令牌或页面中的敏感认证材料。

### 3. 人工认证是显式状态

登录过期、MFA、验证码、条款确认或账号风险提示出现时，Worker 停止自动动作并将任务置为 `waiting-input`，记录闭合的原因代码和管理员操作说明。管理员完成重新认证后创建新的任务尝试；系统不得在后台持续提交凭据或绕过挑战。

### 4. 采集结果先进入 DataSnapshot

采集成功后先经过来源解析、模式校验、时间标记、内容摘要和数据边界校验，再创建不可变 `DataSnapshot`。分析任务只消费已保存快照，不直接消费浏览器 DOM、截图或临时文件。

### 5. 人工导入保持等价 fallback

人工粘贴或文件导入与浏览器采集共用标准化和快照校验边界。Browser Worker 不可用时，系统可以请求人工导入；导入来源必须明确标记，不能伪装成自动采集。

## State and Data Flow

`queued → running → succeeded | waiting-input | failed | cancelled`。

成功路径为：采集任务 → Browser Worker → 受控页面解析 → 标准化记录 → DataSnapshot 校验与持久化 → 原分析运行重新观察输入。`waiting-input` 不计作普通自动重试，只有明确的人工恢复动作才能继续。

## Security and Compliance

- 数据源启用前完成公司账号授权、站点条款和数据合规审查。
- 日志只记录任务、连接器、页面阶段和闭合错误代码，不记录页面正文或认证秘密。
- 截图、HAR、trace 和下载文件默认禁用；诊断性留存必须另行批准并设置短期保留。
- 会话读取权限只授予 Browser Worker，普通 Worker 与模型提供商不可访问。

## Deferred Adoption

该 change 只有在后续实现完成、通过安全与合规验收并由独立发布 change 批准后才能生产启用。当前 MVP 的人工导入和 `waiting-input` 行为保持主路径。
