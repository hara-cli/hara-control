# Matrix / Synapse 分层源码研究计划

> 状态：执行中
>
> 日期：2026-07-26
>
> 目的：通过真实源码学习现代实时聊天系统的 Room、Event、Membership、Permission、Storage 和
> Sync 设计，再映射到 Hara；不修改、不 fork、不复制 Synapse 实现。

## 1. 当前研究工作区

已完成第一阶段仓库准备：

```text
/Volumes/Jeff2TEXTEND1/github/chat-research/
└── synapse/
```

当前 Synapse：

```text
repository: https://github.com/element-hq/synapse.git
clone: shallow + partial
commit: 97fb38eca66f74c4a761e1b1b394e4d19486e61b
size: approximately 54 MiB
```

这是一个固定源码快照。研究文档必须记录提交 SHA，后续升级快照时不能把旧结论无条件套到新代码。

官方入口：

- [Synapse source](https://github.com/element-hq/synapse)
- [Matrix Specification](https://spec.matrix.org/latest/)
- [Element Web source](https://github.com/element-hq/element-web)
- [Matrix JavaScript SDK](https://github.com/matrix-org/matrix-js-sdk)

Synapse 采用 AGPL-3.0 或商业许可双许可。可以研究架构、记录独立设计结论；不要把实现代码复制到
Hara，任何需要复用实现的情况必须先做单独许可审查。

## 2. 仓库顺序

不要一次下载并扫描全部项目。严格按下面顺序：

1. **Synapse**：房间 → 消息事件 → 权限 → 存储 → Sync；
2. **Matrix Spec**：解释协议为什么要求源码这样实现；
3. **Element Web + 它锁定的 matrix-js-sdk 版本**：客户端状态、时间线、本地回显和窗口同步；
4. **Hara 映射**：把可复用概念转成中心化 NestJS/PostgreSQL 设计。

完成 Synapse 的 00–05 文档后再下载 Matrix Spec；完成服务端地图后再下载 Element Web。
下载 Element Web 后，从其 lockfile/manifest 确认准确的 `matrix-js-sdk` 版本，不用任意最新版本做比较。

目标目录最终可以是：

```text
/Volumes/Jeff2TEXTEND1/github/chat-research/
├── synapse/
├── matrix-spec/
├── element-web/
└── matrix-js-sdk/
```

研究产物版本化保存在 Hara 工作区：

```text
hara-control/docs/study/matrix/
├── 00-source-snapshots.md
├── 01-synapse-codebase-map.md
├── 02-message-send-flow.md
├── 03-event-storage.md
├── 04-sync-flow.md
├── 05-membership-permissions.md
├── 06-matrix-spec-crosswalk.md
├── 07-element-client-state.md
├── 08-local-echo-offline.md
├── 09-hara-gap-analysis.md
├── 10-hara-data-model.md
└── 11-hara-delivery-plan.md
```

将研究文档放在 Hara Git 仓库中，可以审查结论变化，而不污染第三方源码 clone。

## 3. 每次 Codex 会话的约束

第三方源码根目录后续可以放置下面的 `AGENTS.md`。目前尚未写入外置磁盘仓库，先把规范保存在此：

```md
# Repository study instructions

## Goal
This repository is used to study the architecture of a modern real-time
messaging system. The goal is not to modify or fork Synapse.

## Rules
- Do not modify source code unless explicitly requested.
- Base every architectural conclusion on actual source files.
- Always provide file paths, class names, and function names.
- Distinguish Matrix protocol design from Synapse implementation details.
- Trace one complete request/data flow at a time.
- Prefer Mermaid for relationships and sequences.
- Identify reusable ideas for a centralised NestJS/PostgreSQL service.
- Identify Matrix-specific mechanisms that Hara should not copy.
- Record the exact repository commit used for every study document.
- Never copy AGPL implementation code into Hara.

## Output
Write versioned study notes to the Hara repository, not this vendor clone.
```

执行规则：

- 一次会话只研究一个子系统；
- 先读入口和测试，再追踪调用链；
- 不以 README 代替源码证据；
- 结论必须标注文件、类/函数和提交 SHA；
- 不在文档中粘贴大段第三方实现；
- 不运行全量测试或安装全部开发依赖，除非研究问题确实需要；
- 对推测标记“待验证”，不能写成事实；
- 每份文档最后必须有“可借鉴 / 不应复制 / Hara 缺口”。

## 4. 源码证据格式

每个结论使用统一表格：

| 结论 | 源码证据 | 协议证据 | Hara 含义 | 置信度 |
| --- | --- | --- | --- | --- |
| 示例：发送事件入口 | `synapse/rest/client/room.py::RoomSendEventRestServlet` | Client-Server send event | API 接收层与事件创建层分离 | 高 |

调用链使用：

```text
HTTP route
  → authentication
  → room/membership authorisation
  → event construction
  → persistence transaction
  → notifier / stream wake-up
  → client sync
```

文档至少回答：

1. 谁创建或调用它；
2. 输入与输出；
3. 权限边界；
4. 事务边界；
5. 幂等与排序；
6. 失败恢复；
7. 性能缓存；
8. Hara 是否需要。

## 5. 阶段任务

### 00. 固定源码快照

输出 `00-source-snapshots.md`：

- repo URL；
- commit SHA；
- clone 时间；
- license；
- 后续依赖仓库版本；
- 研究工具链；
- 哪些结论仅适用于该快照。

验收：任何一条结论都能追溯到一个确定提交。

### 01. Synapse 项目地图

只分析源码，不修改：

```text
请为当前 Synapse 快照建立项目地图。
必须根据源码而不是 README 回答：
1. 启动入口和进程/worker 结构；
2. REST 注册方式；
3. handlers、storage、replication、federation 的边界；
4. 数据库访问层和迁移；
5. notifier 与 stream；
6. Room、User、Event 的主要实现位置；
7. 推荐阅读顺序。
所有结论写出文件、类和函数。
```

输出 `01-synapse-codebase-map.md`。

### 02. 文本消息发送链

已确认首批入口：

- `synapse/rest/client/room.py::RoomSendEventRestServlet`
- `synapse/handlers/message.py::EventCreationHandler`
- `synapse/handlers/message.py::EventCreationHandler.create_and_send_nonmember_event`

研究任务：

```text
追踪一条 m.room.message 从客户端 HTTP 请求到事务提交和通知的完整调用链。
重点：认证、membership/power-level 检查、txn id 幂等、事件构造、
state/auth、持久化、stream position、notifier。
只分析文本发送，不扩展到 federation 或 E2EE。
```

输出 `02-message-send-flow.md`，包含 Mermaid sequence diagram。

### 03. Event 持久化

从消息链实际调用到的 persistence controller 和 store 继续向下：

```text
分析事件持久化事务：
1. 事件主体、JSON、state、edges、current-state 分别存在哪里；
2. stream ordering 如何生成；
3. 一次事务包含哪些写入；
4. 重试/幂等如何避免重复；
5. 提交后怎样唤醒同步和推送；
6. 哪些表只服务 federation/DAG。
```

输出 `03-event-storage.md`。不要先扫描整个 schema；只追发送链使用的表。

### 04. `/sync` 增量同步

已确认首批入口：

- `synapse/rest/client/sync.py::SyncRestServlet`
- `synapse/handlers/sync.py::SyncHandler.wait_for_sync_for_user`

研究任务：

```text
追踪 /sync：
1. since token 的结构和解析；
2. 用户已加入房间如何确定；
3. timeline 增量和 limited/gap；
4. state、ephemeral、account data、presence、unread 如何合并；
5. long poll 怎样被 notifier 唤醒；
6. token 何时推进；
7. 大账户/大房间的性能保护。
```

输出 `04-sync-flow.md`。把传统 `/sync` 和 Sliding Sync 分开记录。

### 05. Membership 与权限

已确认首批入口：

- `synapse/handlers/room_member.py::RoomMemberHandler.update_membership`
- `synapse/handlers/room_member.py::RoomMemberHandler.update_membership_locked`
- `synapse/event_auth.py`

研究任务：

```text
分析 invite/join/leave/kick/ban、join rule、membership event 和 power level。
回答谁可以发送哪类事件，授权状态从哪里读取，成员变化如何写成事件，
并把机制转成适合 Hara 的 Tenant/Community/Channel 权限模型。
```

输出 `05-membership-permissions.md`。

### 06. 用 Matrix Spec 交叉验证

此时再克隆或读取 Matrix Spec：

- 为 02–05 每个核心行为找到规范条款；
- 区分“协议必须”与“Synapse 实现选择”；
- 标出 federation、event DAG、state resolution、room version、E2EE 特有机制；
- 明确 Hara 首期不实现的内容。

输出 `06-matrix-spec-crosswalk.md`。

### 07. Element 客户端状态

完成服务端研究后再下载 Element Web。首批关注：

```text
Lifecycle / MatrixClient 初始化
SpaceStore
RoomListStore
Timeline / RoomView
matrix-js-sdk SyncApi 或 SlidingSyncSdk
```

研究：

- 登录后怎样启动 client sync；
- active space 只负责导航还是权限；
- room list、timeline、unread 的状态来源；
- 新事件怎样合并到本地房间；
- 多窗口/重连怎样恢复。

输出 `07-element-client-state.md`。

### 08. 发送、本地回显和失败恢复

在 Element Web 和其锁定 SDK 中追踪：

- composer → `sendEvent`；
- pending event/local echo；
- server event 与本地事件去重；
- retry/cancel；
- attachment upload；
- offline/reconnect。

输出 `08-local-echo-offline.md`。

### 09. Hara 差距分析

同时读取：

- `hara-control/prisma/schema.prisma`
- `hara-desktop/src/App.tsx`
- `hara-desktop/src/client.ts`
- `hara-cli/src/gateway/matrix.ts`
- `hara-cli/src/gateway/feishu.ts`

输出：

1. 可复用概念；
2. Matrix 特有、Hara 不应复制的设计；
3. realm、membership、channel、event、sync、file、search 缺口；
4. 当前 RLS、cursor、通知、bridge 风险；
5. 建议先修的安全边界。

输出 `09-hara-gap-analysis.md`。

### 10. Hara 数据模型和模块

根据前九份证据设计：

- PostgreSQL 表和复合约束；
- RLS；
- Event + projection + Outbox；
- sync cursor；
- NestJS modules；
- object storage；
- bridge mapping；
- Account/Tenant/Principal/Community/Channel/AgentRun。

输出 `10-hara-data-model.md`。不得直接把 Matrix 表结构翻译成 Prisma。

### 11. 交付路线

输出 `11-hara-delivery-plan.md`，至少包含：

- 内部群 MVP；
- Agent/Task；
- 飞书双向桥；
- 公共社区；
- 迁移与回滚；
- 性能基准；
- 安全验收；
- 每阶段不做什么。

该文档要与
[`collaboration-platform-architecture.md`](./collaboration-platform-architecture.md)
保持一致。

## 6. 推荐阅读主线

### 消息发送

```text
synapse/rest/client/room.py
  → synapse/handlers/message.py
  → persistence controller / events store
  → notifier / streams
```

### 同步

```text
synapse/rest/client/sync.py
  → synapse/handlers/sync.py
  → storage/databases/main/stream.py
  → synapse/streams/
  → sliding_sync（单独研究）
```

### 成员和权限

```text
synapse/handlers/room_member.py
  → synapse/event_auth.py
  → membership / current state stores
```

遇到间接调用时，以当前快照的真实引用为准，不强行套用这张初始路线。

## 7. 工具与成本控制

- clone 使用 `--depth 1 --filter=blob:none`，除非需要历史演进；
- 搜索优先 `rg`，再按调用关系打开少量文件；
- 每次先记录目标函数，再向上找 caller、向下找 callee；
- 不执行“理解整个仓库”式提示；
- 不把完整源码塞进上下文；
- 每个阶段完成一份短文档和一张主流程图；
- 安装依赖前先确认研究是否真的需要运行代码；
- 第三方 clone 可随时重建，Hara 研究文档必须 Git 管理。

## 8. 完成定义

研究完成不是“读完 Matrix”，而是满足：

1. Hara 的每个核心设计决策都有 Matrix/Discord/现有源码证据；
2. 能画出消息发送、持久化、同步和权限四条完整调用链；
3. 明确哪些机制只服务 Matrix 联邦；
4. 产出可独立实现的 NestJS/PostgreSQL 模型，而非移植；
5. 可以用测试验证租户隔离、幂等、顺序、断线恢复和权限；
6. 后续 Codex 只需读取相关 study 文档和少量源码即可继续工作。
