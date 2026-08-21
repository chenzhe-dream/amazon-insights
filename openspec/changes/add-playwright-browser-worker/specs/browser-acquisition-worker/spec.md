## Purpose

定义隔离浏览器采集 Worker 的任务、秘密、人工认证、快照和降级边界，使浏览器能力不可用时不会破坏分析主流程。

## ADDED Requirements

### Requirement: 浏览器采集在独立 Worker 中运行

系统 SHALL 只在独立 Browser Worker 进程中执行需要浏览器会话的采集任务，并禁止 Web 进程和普通分析 Worker 读取会话或启动浏览器。

#### Scenario: 浏览器采集任务被领取
- **WHEN** 持久队列中存在已授权的浏览器采集任务
- **THEN** 只有具有 Browser Worker 服务身份的进程可以领取任务并加载对应会话引用

#### Scenario: Web 请求触发采集
- **WHEN** Web 接收到需要浏览器数据的分析请求
- **THEN** Web 只创建持久任务，不直接启动 Playwright、Chrome 或脱离进程

### Requirement: 会话秘密保持隔离

系统 SHALL 加密保存浏览器会话，并只在 Browser Worker 的最小权限边界内解密；Cookie、密码和令牌不得进入前端、日志、任务载荷、DataSnapshot 或模型输入。

#### Scenario: Worker 记录执行日志
- **WHEN** Browser Worker 完成或失败一次任务尝试
- **THEN** 日志只包含会话引用和闭合状态，不包含可复用认证秘密

### Requirement: 人工认证进入 waiting-input

系统 SHALL 在登录失效、MFA、验证码、条款确认或账号风险提示需要人工处理时停止自动动作，并把任务置为 `waiting-input`。

#### Scenario: 会话已经失效
- **WHEN** Browser Worker 检测到登录页或认证挑战
- **THEN** 系统保存闭合原因和管理员操作提示，不进行无限重试或自动绕过

#### Scenario: 管理员完成重新认证
- **WHEN** 管理员在受控流程中更新会话并确认恢复
- **THEN** 系统创建新的任务尝试，而不是修改旧尝试的历史结果

### Requirement: 自动采集产生版本化 DataSnapshot

系统 SHALL 在浏览器数据通过来源、模式、时间和完整性校验后创建不可变 DataSnapshot，并让分析运行只消费该快照。

#### Scenario: 页面采集成功
- **WHEN** Browser Worker 获得符合预期模式的数据
- **THEN** 系统保存来源、采集时间、转换版本和内容摘要后发布新的 DataSnapshot

#### Scenario: 页面结构无法识别
- **WHEN** 采集内容不符合已批准的解析模式
- **THEN** 系统拒绝创建 ready 快照并返回闭合失败，不把原始页面内容交给模型猜测

### Requirement: 人工导入提供等价 fallback

系统 SHALL 在 Browser Worker 不可用或等待人工认证时继续允许经校验的粘贴或文件导入，并明确标记其来源类型。

#### Scenario: 用户选择人工导入
- **WHEN** 浏览器任务处于 `waiting-input` 且用户提供合法导入数据
- **THEN** 系统通过相同标准化边界创建人工来源 DataSnapshot，并恢复原分析运行的输入检查

### Requirement: 生产启用必须后置批准

系统 SHALL 在安全、合规、恢复和秘密脱敏验收完成且后续发布 change 明确批准前保持 Browser Worker 的生产能力关闭。

#### Scenario: 仅完成技术实现
- **WHEN** Browser Worker 代码存在但尚未完成发布审批
- **THEN** 生产环境不得领取浏览器采集任务
