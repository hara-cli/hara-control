# hara 知识 / 记忆 / 留痕 统一方案(2026-06-23,4 专家汇总)

> Jeff 提出四问:① 向量化 + 代码资产扩展(skill 也是资产、多 scope、按语言/框架)② 记忆加"潜意识"低频层、要不要向量 ③ 知识库(个人/公司/公共,本地+远程)④ 公司工作行为留痕。4 位专家(taxonomy / vectors / memory / audit)并行分析,结论高度收敛——下面是统一方案。

## 0. 统一洞察(把四问串成一个东西)

**不是四个系统,是一个底座 + 三个消费者 + 一条审计流:**

```
        ┌──────────────── 检索底座(向量 + 词法) ────────────────┐
        │  VectorStore 端口:server pgvector(org 权威)+ 设备 zvec(本地+镜像) │
        │  词法是地板(零依赖/离线),向量是默认(入组即开);一个嵌入契约      │
        └───────▲───────────────────▲───────────────────▲──────────┘
                │                    │                   │
        ┌───────┴──────┐   ┌─────────┴────────┐   ┌──────┴──────┐
        │ 知识能力库     │   │  记忆(3 层)      │   │  知识库 KB   │
        │ Asset(kind×   │   │ short/long/      │   │ =同一个库的   │
        │  scope)       │   │ **潜意识(向量)** │   │ KNOWLEDGE kind│
        └──────────────┘   └──────────────────┘   └─────────────┘

        ┌──────────────── 工作行为留痕(独立 append-only 流)──────────┐
        │  WorkSession → 喂周公/zhougong 评估 + 合规审计               │
        └────────────────────────────────────────────────────────────┘
```

**关键收敛**:① 代码库/skill 库/知识库 = **同一个库的三个 facet**(`kind` 维度区分);② 向量从"opt-in"升为"入组即默认",但**词法仍是地板**;③ 潜意识记忆 = **向量存在的那一层**;④ 留痕是**独立流**,不混进 AuditLog。

---

## A. 统一知识 & 能力库(taxonomy 专家)

**一个库,两条轴。** 不建独立"知识库"子系统——CLI 早已把 skills+code-assets 合成一个语料(`recall.ts assetSearchRoots`),B2 的 `Asset` 是同一决定。

- **kind 轴(是什么 / 怎么用)**:SNIPPET / PLAYBOOK / CONVENTION / SKILL / **KNOWLEDGE(新增=知识文档)**。SKILL 保留 `skills/<slug>/SKILL.md` 渐进披露布局,其余扁平 `*.md`,但**同一个 store**。
- **scope 轴(在哪 / 谁见 / egress 边界)**:`project(设备本地不上传) > personal > team > org > public`。Jeff 的"个人/公司/公共"= UI 三标签映射到 PERSONAL / (TEAM+ORG) / PUBLIC(server 保留 4 值精度,B3 RLS 依赖 TEAM/ORG)。
- **维度三裁**:scope/kind/lifecycle/trust/origin = 一等枚举;**language = 列**(已有);**framework = tag(不建列)**;**project = 设备本地,不进 server 枚举**(否则破坏 egress 边界);其余一律 tag + faceted 搜索。**反对维度爆炸**:新"维度"默认降级成 tag。
- **本地 vs 远程**:`personal` 是**唯一双归属**(本地 `~/.hara` 权威工作副本 ⇄ 远程跨设备镜像,双向同步,contentHash delta + LWW);team/org/public = 远程权威 + 本地只读缓存;project = 纯本地。
- **C 端独立开发者远程个人库**:当前 `Asset.orgId` 非空 → solo dev **无远程个人库**(真缺口)。MVP=本地-only;远程解法=SaaS 注册时**自动建"一人 org"**(org-of-one),同一套 `Asset` 机制零改 schema 服务 C 端。**依赖 SaaS 身份(hub)**。
- **B2 增量(干净超集,非破坏)**:`AssetKind` 加 `KNOWLEDGE`;`Asset` 加 `summary`(一行索引,给非 skill 也有渐进披露索引行);PERSONAL scope **自动发布**(自己的东西免审,使个人同步无摩擦);SCOPE_TIER 拆 team>org;PUBLIC promote 需 `ORG_VERIFIED` + 强 gate。CLI:`skill_create`→泛化加 `kind` 参数 + `knowledge/` 目录;`assetSearchRoots` 加 knowledge 目录 + 拉下的 team/org/public 缓存。

## B. 检索底座 / 向量(vectors 专家)

**词法地板 + 向量默认(入组即开),不是二选一。** 之前"词法优先/向量 opt-in"在当时对(zvec 当时是 vaporware);**现在 zvec v0.5.0 出了官方 npm 包 + 原生 FTS+hybrid**,成本基线变了,可以升级。

- **两个向量库 = 一个逻辑语料,两个物理副本**:
  - **server pgvector**(org 语料 = 权威):给 `AssetVersion` 加 `embedding vector(1024)` 列,在 `review()` 发布时嵌入(同 searchText 计算点);**一个列 + 一个索引**,RLS 同一条 SQL WHERE 管隔离 —— 3 人团队不另起一个数据存。
  - **设备 zvec**(本地 + 镜像):索引本地 repo/assets/memory **+ 拉下的 org 镜像**(镜像带**预算好的向量**随同步下来,设备零嵌入开销、离线可用、维度天然一致)。
- **一个嵌入契约,模型可配置(本地/远程,不 pin)**:config `embedProvider`/`embedModel`/`embedDim` —— **本地**=ollama `nomic-embed-text`(768)或本地 Qwen embedding(这台 Mac 可跑);**远程**=Qwen `text-embedding-v3`(1024)via LiteLLM 网关(同一 `/embeddings` 端点,单一成本计量)。**硬约束:同一索引语料 {model,dim} 必须一致(不可混维,否则 cosine 是垃圾)**;契约 `{model,dim,normalized}` 持久化(`Organization.embedConfig` + manifest 回显),换模型 = 按 `(contentHash, modelId)` 后台 re-embed。
- **一个 `VectorStore` 端口,三个消费者**(assets / memory-潜意识 / KB):`upsert/query(collection, q, k, filter)`;`semindex.ts` 的 chunker + `looksSecret` 密钥过滤是**共享的,所有消费者复用**(防 .env 漏进嵌入端点)。
- **混合排序**:RRF 融合(词法整数分 vs cosine 浮点不可线性混,RRF 免标定)+ scope-tier/trust/recency 乘子;**dedup-before-save 仍用词法整数分**(给人看的写入闸要 crisp)。

## C. 记忆三层 + 潜意识(memory 专家)

**short / long / 潜意识。** 潜意识 = **向量存在的那一层**。

- **short**(workingSet,每会话,**总注入**)/ **long**(`MEMORY.md` 高显著,**冻照 digest 注入**,封顶 2000 字)/ **潜意识(新)**:`MEMORY.attic.md` + `memory.stats.json` 侧车,**默认不注入**,仅在**回合级相似度命中**时检索增强(top-2,~600 字,阈值 0.35 比常规高=精准不贪)。
- **为什么独立一层**:long 的 2000 字封顶今天靠 `capAtLine` 任意截断长尾——潜意识让淘汰**按显著性**而非文件顺序;它是**非破坏降级池 + 有回流路径**(不是坟墓)。
- **衰减机制(频率较低)**:`score = 显著性 + log2(1+访问数) − 距上次访问天数/30`(LFU+LRU,无 LLM)。long→潜意识(score 低 + >30 天冷)在 **`hara memory distill` 里降级**(已有命令,零新进程);潜意识被向量命中 `hitCount≥3` → 回升 long;真删只走显式 `memory_forget` 或硬底(1 年 + 零命中)。
- **注入位置**:潜意识 recall 在**用户回合**的 `recalledContext` seam 注入(非系统提示 → **不破坏 prefix-cache**),标注"subconscious recall — verify before relying"(非权威)。
- **Guard(最高风险=无提示拉回冷内容)**:每次 recall 跑 `scanMemory` block-on-load;**移植 hermes 更强的威胁模式集 + 隐形 unicode 检测**(hara 现仅 3 条注入模式,太薄)。
- **借鉴 hermes**:`§` 分隔多行条目(现行行式会切碎多行事实)、原子写、frozen-snapshot 纪律、`prefetch` 生命周期作潜意识 recall 的契约。
- **分期**:P1 潜意识层**先用词法**(attic 文件词法搜)证明降级/回流闭环、零嵌入依赖;P2 接向量;P3 公司 scope 走 server pgvector。

## D. 工作行为留痕(audit 专家)

**一条独立 append-only 流,不混 AuditLog**(AuditLog=治理事件,留痕=工作产出,不同 actor/量级/留存/消费者)。

- **单位 = `WorkSession`**(每会话摘要,**默认仅元数据**):谁(personId via per-person enroll + digitalEmployee/roleKey)/ 干了啥(repoHash、taskTitle、kind)/ 形态(toolCalls 计数、filesTouched + **路径 hash**、approvals)/ 结果(outcome、commitShas)/ 成本(model/tokens/cost —— **从 LiteLLM spend 对账,不信客户端**)/ 时间 + `prevHash/rowHash` 防篡改链。`WorkEvent` = 可选子事件(拒绝/审批/guardrail)。
- **捕获**:新 `POST /v1/events`(device-token,**不**走 heartbeat),设备本地按会话聚合、批量 flush;服务端 `deviceFromBearer` 归属 + `redactSecrets/scanForInjection` 再扫 + `audit.log("work.session.ingest")` 记元事件。
- **隐私三层**:**T0 元数据(默认,所有人)** / T1 标题(org opt-in,guard 脱敏)/ **T2 正文摘录(仅自部署 + 短留存)**;**SaaS 硬封顶 T1**(永不持别家代码);路径一律 hash。
- **喂周公**:hara-control 月度汇总 `WorkSession` → 经周公 `emit_event` SDK 作新 `source_type='hara_work'`(权重~0.15 < feishu_task 0.20,confidence<1;只映 `ai_eligible` 客观维 delivery/rigor,**绝不碰主观维**);机制 = hara-control 暴露 `GET /admin/work/rollup`,周公 job 拉取后自己 `emit_event`(单写者纪律);**仅 Nanhara 内部 org opt-in,SaaS 客户的留痕永不流入周公**。
- **监控伦理**:会话粒度(非按键)、元数据默认、**对工人透明**(`hara work show-record` 可看自己的记录)、**对称**(Jeff 说"我的工作行为也要留痕"→ 创始人同 tier);"工人能看的留痕=治理,看不了的=间谍软件"。

---

## 统一分期(四线合并)

- **P0(server,最高 ROI,自包含)**:AssetVersion 加 pgvector + 发布时嵌入 + org 资产搜索升级(修当前 substring+500 上限);`KNOWLEDGE` kind + `summary`;记忆潜意识层(**词法版**先证闭环);`WorkSession` MVP(T0 元数据 + `/v1/events`)。
- **P1(设备)**:`VectorStore` 端口 + zvec 替 `semindex` 暴力 JSON;向量"入组即默认"(lexical 仍地板);个人**本地**知识库端到端;潜意识接向量;`config` 加 `embedDim`。
- **P2(镜像 + 融合 + 同步)**:CLI 拉取镜像客户端(`manifest(since)`→向量→zvec)+ RRF 融合 + scope/trust/recency 乘子;个人**远程**双向同步;`WorkEvent`/T1 + 周公月度对接。
- **P3**:public 市场(走 OSS git registry,非控制面);C 端 org-of-one 远程个人库(依赖 SaaS 身份);T2 正文(自部署);DiskANN(需要才上)。

## 关键不变量(全程守)
markdown-as-SSOT(向量/索引/stats 全派生可重建);词法地板永不消失(离线/无模型可跑);egress(off-machine)需人确认 + guard 双扫;潜意识/留痕的 secret 过滤 load-bearing;3 人团队低运维(一个 pgvector 列 > 另起数据存;distill 复用做记忆维护,零新进程)。

## 决策已定(2026-06-23 Jeff)
1. ✅ **C 端远程个人库**:本地-only 先发,远程随 SaaS(org-of-one)跟上。
2. ✅ **向量升为默认**(入组即开,词法仍地板)。
3. ✅ **public 走 git registry,控制面到 `org` 止**。⚠️**澄清:这里"OSS"=开源软件(Open Source Software)**,指公共市场走一个**公开 GitHub 仓**(像 plugin marketplace),**不是阿里云 OSS 对象存储——不需要开 bucket**。全方案**资产存储=Postgres(server)+ 本地 markdown(设备),零对象存储依赖**。
4. ✅ **嵌入模型可配置(本地/远程),不 pin**:config `embedProvider`/`embedModel`/`embedDim` —— 本地=ollama `nomic-embed-text`(768)或本地 Qwen;远程=Qwen `text-embedding-v3`(1024)via 网关。**硬约束:同一索引语料 {model,dim} 必须一致(不可混维)**,换模型=按 contentHash 后台重嵌入。这台 Mac 本地可跑(ollama)。
5. ✅ **潜意识 = 存档机制 + 权重**:每条记忆带权重 `score = 显著性 + log₂(1+访问数) − 距上次访问天数/30`;**降级规则** `score<阈值 且 冷却>30 天` → 存档进潜意识(非破坏、不注入);**回流规则** 向量命中 `hitCount≥3` → 升回 long;`pinned`=权重∞ 永不存档。P1 先词法证闭环、P2 接向量。
6. ✅ **留痕**按方案(会话边界/周公权重~0.15/创始人同 tier/分层留存);细节政策值实现时定。
