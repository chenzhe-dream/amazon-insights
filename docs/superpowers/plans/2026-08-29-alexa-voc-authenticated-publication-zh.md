# Alexa VOC 认证发布执行摘要

## 目标

在不改变业务操作顺序的前提下，要求 Alexa 手动导入及相关 Web 写操作必须经过同源校验和有效登录认证；导入后的数据通过正式 31900 supervisor 的不可变产物发布，任何路径都不得启动第二套 Web 或使用端口 3000。

## 为什么修

当前导入、Alexa 同步和系统重建路由可绕过认证执行写入或启动后台进程；旧后台重建还可能调用 `start-team-server.ps1` 并使用端口 3000。这会造成未授权修改、正式服务被错误替换，以及 31900、31901、58258 的进程归属混乱。本次修复保留现有静态 VOC 投影和页面流程，先关闭安全与发布路径风险。

## 四个实施任务

1. **建立 Web 写操作认证守卫**：新增同源 Origin 检查，并通过现有 Agent client 将 Cookie 交给 31901 的 `/v1/auth/session`；Web 不解析或保存 session token。
2. **保护三个写路由**：为 Alexa import、Alexa sync、system rebuild 接入统一守卫；认证必须发生在读取请求体、写文件、启动任务之前，并按角色限制操作。
3. **建立手动不可变发布模块**：计算 `alexa_voc` 投影内容哈希，生成 artifact 和 manifest，在 build lock 内构建不可变 Web 产物，再写入 reload request。
4. **移除旧后台重启入口**：改造 `scripts/run-background-rebuild.mjs`，只请求正式 supervisor 发布并清理自身锁；不得导入、调用或派生 `start-team-server.ps1`，不得监听 3000。

## 认证规则

- 请求 `Origin` 必须存在且与请求 URL 的 origin 完全一致；缺失或不匹配均返回 403。
- 会话由 31901 校验：缺少或失效登录返回 401；31901 不可用或响应格式不合法返回 503。
- Alexa import 允许 `admin` 与 `member`；Alexa sync 和 system rebuild 仅允许 `admin`，角色不足返回 403。
- 认证失败响应只返回固定中文提示，不泄露内部地址、代理 token、Cookie、数据库 URL、请求头或底层异常正文。
- 通过认证后，JSON、ASIN、空白报告错误返回 400；少于三个可识别维度返回 422；写入异常返回固定脱敏的 500。

## 错误码与发布状态

| 情况 | 结果 | 影响 |
| --- | --- | --- |
| Origin 缺失或不匹配 | 403 | 不读报告、不写文件、不启动任务 |
| 未登录或会话失效 | 401 | 不写文件、不启动任务 |
| 31901 不可用或响应非法 | 503 | 不写文件、不启动任务 |
| JSON、ASIN、空白正文无效 | 400 | 不写文件、不发布 |
| 少于三个维度 | 422 | 不写文件、不发布 |
| VOC 写入失败 | 脱敏 500 | 不启动发布 |
| 已有发布任务 | 409 或 pending 提示 | 不生成第二个 build |
| build 或产物失败 | failed | 保持当前正式进程不变 |
| supervisor 暂不可用 | pending | 保持当前正式进程不变 |
| supervisor 预检失败 | failed | 回退或保留已知健康产物 |

## 正式发布流程

1. 已登录用户从 31900 VOC 页面发起同源 POST。
2. Web 守卫把 Cookie 交给 31901 验证权限。
3. 路由校验 ASIN、报告文本和至少三维的可识别内容。
4. 现有流程写入 `data/alexa-voc-cache/<ASIN>.txt` 与 `app/rufus-voc-data.ts`。
5. 后台发布生成唯一 artifact identity，并使用 job version `1` 及 `alexa_voc` 内容哈希构建不可变产物。
6. 面向当前正式 worktree/31900 原子写入 reload request 后退出。
7. 正式 supervisor 独自预检并更新 31900；失败时保留原健康 Web。31901 与 58258 不由该流程替换。

## 明确不触碰事项

- 不迁移 Alexa VOC 到 PostgreSQL，不改变七维解析、自动抓取或 VOC 定位模型。
- 不新增评论来源，不把手动导入伪装成 ASIN 基础同步，也不创建新的 sync job。
- 不调用 `start-team-server.ps1`，不监听或生成端口 3000，不启动第二套 Web。
- 不部署、push、重启、停止或修改正式 31900、31901、58258。
- 不在本切片实现跨文件原子 VOC 持久化、动态页面读取或完整来源元数据统一。

## 验收标准

- 同源且有效会话的 import 可完成写入；无 Cookie、失效会话、跨源或缺失 Origin 在任何副作用前拒绝。
- import、sync、rebuild 共用认证守卫并执行正确角色策略；错误响应可区分且无敏感信息。
- 短于 600 字但可解析的报告仍可接受；空白、非法 JSON/ASIN 和不足三维的报告分别得到规定错误。
- 发布生成精确 `alexa_voc` 哈希、不可变 artifact 和正确 reload request；已有任务不会重复构建。
- 后台发布失败、reload request 写入失败或 supervisor 不可用时，当前健康 Web 继续运行。
- 源码与测试确认不存在后台到 `start-team-server.ps1`、端口 3000 或第二套 Web 的路径；定向测试、认证/发布回归、lint、项目测试和 fresh build 全部通过后方可提交实现。
