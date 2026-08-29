# Alexa VOC Authenticated Publication Design

## Scope

修复正式系统中 Alexa 手动导入的两个高优先级问题，同时保持现有业务操作顺序不变：用户继续在 VOC 页面选择 ASIN、粘贴 Alexa 报告并点击导入；系统继续解析报告并生成七维矩阵。本切片不把 Alexa VOC 迁移到 PostgreSQL，不改变自动抓取策略，不接入新的评论来源，也不修改 VOC 定位模型执行逻辑。

本切片必须实现：

- Alexa 手动导入只接受当前 Web 同源请求，并要求 31901 确认有效登录会话。
- 导入、Alexa 后台采集和系统重建路由不能绕过既有认证链直接执行写操作或启动子进程。
- 手动导入完成后的构建只能发布为不可变 Web 产物，并由正式 supervisor 消费 reload request 更新 31900。
- 任何路径都不得调用 `start-team-server.ps1`、监听 3000 或启动第二套 Web。
- 认证失败、输入失败、写入失败、构建失败和发布等待必须使用彼此可区分且不泄露敏感信息的结果。

## Current Problem

`app/api/alexa-voc/import/route.ts` 当前直接接受写请求、反射任意 Origin，并在 Web 进程中写入 `app/rufus-voc-data.ts`。`app/api/alexa-voc/sync/route.ts` 和 `app/api/system/rebuild/route.ts` 同样可以直接启动后台进程，没有先经过 31901 的登录会话判断。

手动导入默认调用 `triggerBackgroundRebuild()`。该函数派生 `scripts/run-background-rebuild.mjs`，而该脚本构建后仍调用默认端口为 3000 的 `start-team-server.ps1`。这与当前正式运行决策冲突：31900 必须由 `scripts/start-agent-stack.mjs` supervisor 独占发布，普通数据刷新不能启动、停止或替换 31901 与 58258。

## Considered Approaches

### 1. Authenticate the existing workflow and reuse the formal publication pipeline (selected)

保留现有静态 VOC 数据投影和页面交互。Web 写路由先执行同源检查，再通过现有内部 Agent client 请求 31901 的会话检查；只有有效会话才允许进入解析、写入或派生后台任务。后台重建改为复用不可变 artifact、build lock、reload request 与 supervisor 预检/回退能力。

该方案改动范围最小，能立即关闭未授权写入与旧 3000 路径，同时保持用户已经跑通的手工流程。其限制是 Alexa 数据仍会修改受版本控制的 TypeScript 文件，并且导入后仍需一次构建；这些问题留给后续 PostgreSQL 动态 VOC 切片。

### 2. Persist manual VOC in PostgreSQL and read it dynamically

为项目级 Alexa VOC 草稿增加持久化结构，页面直接动态读取，导入后不再构建。该方案长期更深，但需要新的持久化合同、迁移、页面读取、静态 fallback 和历史数据迁移，超出本次安全修复范围。

### 3. Disable automatic publication

导入只写文件，要求管理员之后手工运行 launcher。该方案能避免 3000，但会让业务人员看不到即时结果，并把发布一致性重新交给人工操作，因此不采用。

## Architecture

### Authenticated Web mutation guard

增加一个供本地 Web 写路由复用的认证 guard。它承担两项职责：

1. 比较请求 `Origin` 与请求 URL 的 origin；缺失 Origin 的浏览器写请求或不匹配 Origin 均拒绝。正式页面的同源 fetch 正常通过，不再返回跨源许可头，也不再提供宽松 OPTIONS 响应。
2. 使用现有 Agent client 把请求 Cookie 交给 31901 的 `/v1/auth/session`，由 Agent 的认证策略判断会话。Web 不解析、复制或持久化 session token，也不向浏览器暴露内部代理 token。

guard 只返回有界的认证角色或失败结果，不把用户记录或凭据带入 Alexa 文件写入实现。Alexa import 允许 `admin` 与 `member`，Alexa sync 和 system rebuild 仅允许 `admin`。三个写路由必须在解析大请求体、写文件或派生进程之前通过 guard。

正式配置下未登录返回 401，角色不足或跨源返回 403，31901 不可用返回 503。所有结果使用固定中文提示，不返回内部地址、token、数据库 URL、请求头或底层异常正文。

### Manual Alexa import

认证通过后，导入路由继续执行当前 ASIN 与非空文本校验，再调用现有 `saveAlexaVocToSystem()`。报告只能属于所选十位 ASIN；无效 JSON、ASIN、空白正文返回 400，无法识别至少三维的报告返回 422，不再统一映射为 500。写入成功后才允许请求后台发布。

本切片保留 `data/alexa-voc-cache/<ASIN>.txt` 与 `app/rufus-voc-data.ts` 作为现有数据投影，不改变七维解析规则。原子 VOC 持久化属于后续切片，但本次测试必须证明无效、未认证或跨源请求不会修改这两个目标。

### Formal Web publication

`run-background-rebuild.mjs` 不再导入、调用或派生 `start-team-server.ps1`。它改为：

1. 为本次手动数据发布生成唯一 artifact identity；由该 identity 派生唯一的 manual publication job identity，并固定使用初始 job version 1，避免引入新的全局版本计数器。
2. 计算 Alexa VOC 投影的内容哈希，并把 `alexa_voc` 纳入允许发布的阶段集合。
3. 通过现有 `publishImmutableWebArtifact()` 在进程间 build lock 内执行 fresh build，生成不可变 artifact 与 manifest。
4. 使用正式 worktree、WEB_HOST 和 WEB_PORT 创建 reload target，并原子写入 reload request。
5. 退出而不启动任何 Web 进程；正式 supervisor 独自消费请求、预检候选 artifact、更新 31900，并在失败时保留已知健康 artifact。

如果 supervisor 暂不可用，请求保持 pending，当前 31900 继续提供旧健康 artifact。后台发布失败只清除本次 rebuild lock 并记录有界状态，不停止当前 31900、31901 或 58258。

### Rebuild ownership and deduplication

保留现有单一 rebuild lock 语义：八分钟内已有发布任务时，新请求返回“构建任务已在进行中”，不生成第二个 build。lock 文件增加本次发布 identity 或状态引用时不得包含 Cookie、token、数据库 URL 或原始 Alexa 报告。

本切片不创建新的 sync job，也不把手工导入伪装成 ASIN 基础同步。手工发布使用明确的 manual Alexa publication identity；它只承担 artifact 与 supervisor 握手，不参与 sync job 的业务状态归并。

## Data Flow

1. 已登录用户在 31900 VOC 页面提交同源 POST。
2. Web guard 把 Cookie 通过内部 Agent client 交给 31901 校验。
3. 导入路由校验 ASIN、文本和 Alexa 报告完整度。
4. 现有解析流程写入原文缓存和七维静态投影。
5. 后台 publisher 在 build lock 内构建并生成不可变 artifact。
6. publisher 写入只面向当前正式 worktree/31900 的 reload request 后退出。
7. supervisor 预检 artifact，成功后替换 31900；失败则保留原健康 Web。

## Error Handling

| Condition | Result | Side effect |
| --- | --- | --- |
| Origin 不匹配或缺失 | 403 | 不读取报告正文，不写文件，不启动进程 |
| 登录会话缺失或失效 | 401 | 不写文件，不启动进程 |
| 31901 不可用或响应不合法 | 503 | 不写文件，不启动进程 |
| JSON、ASIN 或空白正文无效 | 400 | 不写文件，不启动发布 |
| 报告无法识别至少三维 | 422 | 不写文件，不启动发布 |
| VOC 写入失败 | 500 的固定脱敏错误 | 不启动发布 |
| 已有发布任务 | 409 或成功写入后的 pending 提示 | 不启动第二次 build |
| build 或 artifact 生成失败 | 后台状态 failed | 当前正式进程保持不变 |
| supervisor 暂不可用 | publication pending | 当前正式进程保持不变 |
| supervisor 预检失败 | publication failed | 恢复或保留已知健康 artifact |

## Testing

测试遵循 RED-GREEN-REFACTOR，并至少覆盖：

- 同源且有效会话的 Alexa import 可以进入领域写入。
- 无 Cookie、失效会话、跨源 Origin 和缺失 Origin 均在任何文件写入前拒绝。
- import、sync 和 rebuild 三个写路由共用同一认证 guard。
- 短于 600 字但可解析的报告继续被接受；空白和无法识别三维的报告返回输入错误。
- 后台 publisher 生成 `alexa_voc` 内容哈希、不可变 artifact 与精确 reload request。
- 源码和测试中不再存在从后台 publisher 到 `start-team-server.ps1` 的调用。
- 隔离端口集成测试证明 supervisor 只替换 Web，Agent 子进程不替换，参数中不出现 3000。
- 构建失败、reload request 写入失败和 supervisor 不可用不会停止已知健康 Web。
- 定向测试、现有 publication 测试、认证测试、lint、项目测试和 fresh build 全部通过后才允许提交实现。

## Rollout and Rollback

实现与验证只在 `codex/stabilize-resumable-sync-pipeline` 工作树完成，显式暂存本切片文件，不包含现有生成数据 WIP。未经单独批准不部署、不 push、不重启正式 31900/31901/58258。

未来部署前必须确认 active job/stage/attempt/run 均为 0，31900、31901、58258 健康，3000 无监听，正式 fake 模式关闭，目标 commit 与 artifact 可追踪。部署后先验证未登录和跨源写入被拒绝，再用一个不会改变业务数据的受控 fixture 验证发布握手。

若认证 guard 导致合法页面请求失败，只回退 Web 路由接线，不恢复宽松 CORS。若手工发布失败，回退到“不自动发布并提示管理员”的安全状态；任何回退都不得恢复 `start-team-server.ps1` 或端口 3000。

## Deferred Work

- 把 Alexa 原文、七维结果和来源证明迁移到 PostgreSQL，并让页面动态读取。
- 对缓存文件与静态投影执行跨文件原子提交或彻底删除静态写入。
- 统一 Rainforest、Sorftime 与 Alexa 的来源身份、子 ASIN 覆盖和评论样本元数据。
- 为手工 publication 提供页面可轮询的 applied/failed 明细，而不是仅显示“后台构建中”。
