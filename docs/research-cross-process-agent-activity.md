# 跨进程 delegated-work 活跃性观测调研

**状态：** 调研报告，不构成实现授权或产品契约变更
**日期：** 2026-08-05
**目标：** 研究一种不依赖子进程 Pi agent 生命周期、也不直接依赖特定 subagent 插件的机制，使 `pi-continue-watchdog` 不会在 delegated work 尚未结束时误判 aggregate idle。

## 1. 执行摘要

当前问题不是简单的事件漏接，而是**观测域不一致**：

- watchdog 的 hub 是一个 `globalThis + Symbol.for(...)` 的 JavaScript-realm 内注册表，只统计同一 realm 中加载 watchdog 的 attachment；
- 当前 `pi-subagents` 的每个实际 child agent 都是独立的 Pi OS 子进程；异步任务还多一层 detached runner；
- 父 Pi 的 agent loop 可以在异步 subagent 仍运行时进入 settled，因此 `ctx.isIdle()`、父进程 `agent_settled` 和 watchdog 当前的 `busyCount === 0` 都不能代表 delegated work 已结束。

最关键的调研结论是：

> **“属于当前 root session、仍然需要等待的 delegated work”不是操作系统可以自动推断的事实，而是 orchestrator 才掌握的逻辑状态。**

因此，不存在一个既完全无协作、又能正确识别任意子进程逻辑工作的通用 OS 探测方案。PID、进程树、process group、pidfd 都只能回答“某个进程是否还存在”，不能回答：

- 它是否属于当前 root session；
- 它是否只是 runner，真正的 child 是否已经转移；
- 它是否正在运行、暂停、等待父 agent、等待结果投递，或已经逻辑完成；
- nested work 是否仍然存在；
- 一个旧 PID 是否已经被复用。

### 推荐方向

近期最合适的设计是：

1. 建立一个**中立、版本化、位于 parent main JS realm 的 activity-provider registry**；它能跨独立模块加载共享，但不假装覆盖 Worker isolate 或其他 OS process；
2. watchdog 只向 registry 请求当前 root activity domain 的**权威快照**；跨进程事实由 provider 间接汇总；
3. 各 orchestrator/subagent 插件在父进程中注册 provider，并在 provider 内部适配它自己掌握的 foreground、async、nested、recovery 状态；
4. start/end/event bus 事件仅用作“快照可能变化，请重新查询”的 wake hint，不作为权威真相；
5. provider 对重启后仍存活的任务，使用其自己的 durable artifacts、runner close proof、状态文件或 lease 进行恢复与 reconciliation；
6. provider 若处于 recovering/unknown/error，watchdog 默认 **fail closed**：不发起 continuation decision，不发布 user-ready，并通过 TUI 明确显示活动状态无法确认。

这个方案**不要求 watchdog 加载进 child Pi，也不要求 watchdog 与 child Pi 跨进程通信**。跨进程细节由已经拥有这些 child 的 orchestrator 封装；watchdog 只消费父进程里的逻辑快照。

推荐把它理解为：

```text
watchdog
  └─ 查询中立 activity registry
       ├─ pi-subagents provider
       │    ├─ foreground in-memory control records
       │    ├─ async state + status.json/events.jsonl
       │    ├─ process-terminal proof
       │    └─ nested/recovery reconciliation
       ├─ future orchestrator provider
       └─ future external-work provider
```

公开 seam 应保持很小：

```text
register provider
  → snapshot(rootActivityDomain)
       = ready | recovering | unknown
       + exact outstanding work identities
       + provider incarnation/revision
  → subscribe to “snapshot may have changed” hints
```

推荐的具体实现形态是本文所称的 **A/G hybrid**：A 是中立 snapshot registry；G 是 provider 在内部结合实时父进程状态与必要的 durable reconciliation。它不是共享 daemon，也不是让 watchdog 直接读取某个 subagent 插件的私有文件。

该推荐有两个必须正面承认的边界：

- **Decision fencing：** timer expiry 时的空快照并不足够。decision 进行期间任何 provider readiness、revision 或 item-set 变化，都必须使当前 decision stale；在执行 continue、终局 unlock、decision-failed/exhausted 或发布 user-ready 之前必须再次验证。
- **Expected-provider barrier：** 一个空 registry 无法区分“确实没有 orchestrator”与“provider 尚未注册、加载失败或重启后尚未恢复”。如果产品要求重启安全，就必须由 core/config/session durable marker 等来源声明 expected providers；否则 A/G 的严格保证只能限定为 provider 成功注册期间。

---

## 2. 调研范围与源码基线

本报告核对了以下本地源码和权威文档：

| 项目 | 基线 | 相关范围 |
|---|---|---|
| `xz-dev/pi-continue-watchdog` | `ede88cecbc910451175f2bedad0c4931cc36d47f` | `src/hub.ts`, `src/runtime.ts`, docs 与测试 |
| `xz-dev/pi-subagents-nicobailon` | 活跃性源码等价于 `cae65585694e54754286fa107449bbcf98a0af0c`；调研结束时安装 HEAD 为 `712cf55be29889b1db51a90a1f875fce0a7491dc`，两者之间仅变更 `CHANGELOG.md` | foreground/async/workflow/nested/recovery、公开 API、artifacts |
| `xz-dev/pi` | `4bf91cbf5ae62b4a4f9f764a978aab5600a18f98` / Pi `0.83.0` | Extension lifecycle、`pi.events`、EventBus 实现 |

另外比较了 Node.js、Linux、Windows、SQLite、LSP、DAP、OpenTelemetry、systemd、Kubernetes Lease、Celery 和 Temporal 的官方文档或规范。

### 调研边界

本报告回答的是：

- 如何可靠地判断“当前 root activity domain 下，由合作 provider 报告的 delegated work 是否仍 outstanding”；
- 如何避免依赖 child Pi agent 的 extension lifecycle；
- 如何在插件中立、故障可见、可恢复和简单性之间取舍。

本报告不承诺：

- 自动发现机器上所有不合作的进程或任务；
- 把任意 PID 自动分类为当前 Pi session 的 delegated work；
- 在没有 producer/orchestrator 提供语义的情况下恢复完整逻辑状态。

---

## 3. 当前架构与根因

## 3.1 Watchdog 当前的观测域

`src/hub.ts` 已经明确写出当前边界：

- registry 是 process-local；
- 只覆盖加载了本 extension 的 same-process attachments；
- isolated、out-of-process 或未加载 extension 的 children 永远不可见。

hub 的状态变化只来自本 attachment 的生命周期：

- `session_start`：绑定 attachment；
- `agent_start`：`markBusy`；
- `agent_settled`：在 Pi 确认真 idle 后 `markIdle`；
- detach/shutdown：移除 attachment。

`allObservableIdle()` 的定义只是：已经选出 main，且本 realm 所有 attachments 的 `busyCount()` 为零。`Symbol.for("pi-continue-watchdog:observable-agent-domain:v1")` 能让同一 JS realm 中独立加载的物理模块副本共享状态，但不能跨越 OS process、Worker isolate 或另一个 `globalThis`。

所以现有设计本身没有违反自己的文档；它只是无法覆盖现在 subagent 插件的进程模型。

## 3.2 Pi 的事件总线也是进程内的

Pi 的 `createEventBus()` 直接基于 Node `EventEmitter`。`pi.events.emit/on` 是同一个 Pi runtime 内扩展之间的通信机制，不是跨进程 transport，也不提供 replay、持久化或 snapshot。

这意味着：

- parent realm 可以通过 `pi.events` 观察 parent 插件发布的 subagent 事件；
- child process 的 `pi.events` 不会自动传到 parent；
- reload/restart 后，旧事件不会重放；
- 单纯订阅 start/end 仍会有“订阅前已经启动”“completion 丢失”“producer 重载”的一致性问题。

## 3.3 当前 `pi-subagents` 的进程/realm 图

### Root/parent Pi

父 Pi 是一个 OS process 和主 JS realm，加载 watchdog 与 pi-subagents。它拥有：

- watchdog hub；
- pi-subagents 的 `SubagentState`；
- foreground control maps；
- async job tracker、watcher、scheduler；
- parent `pi.events`；
- scripted workflow 使用的 Worker。

父 Pi 的 `agent_start/agent_settled` 和 `ctx.isIdle()` 只描述父 agent loop。它们不会包含 detached child lifetime。

### Foreground child

foreground `subagent` tool 在父端保持 pending，因此父 agent 通常不会 settle；但是每个实际 agent 仍由 `child_process.spawn(...)` 启动成独立 Pi process：

```text
parent Pi realm
  └─ pending subagent tool
       ├─ child Pi process / independent realm
       └─ more child Pi processes for parallel work
```

pi-subagents 自己在父进程里有精确的 foreground control records，能够知道 active children。这个状态目前是内部实现，没有中立公开 snapshot API。

“detached foreground”仍然不是 daemon：父端停止等待该 tool path，但原 child 和 callback 可以继续运行；reload/restart 不保证它能正确存活或恢复。因此它尤其不能靠父 Pi idle 代表完成。

### Async child

async 模式首先启动 detached runner：

```text
parent Pi realm
  └─ detached runner OS process
       ├─ child Pi writer process
       ├─ child Pi writer process (parallel)
       └─ later steps / nested runners
```

runner 使用 `detached: true`，父端在 launch acknowledgment 后立即返回。runner 再通过 `spawn(...)` 启动实际 Pi writer。此时父 agent 很快可以 settled，而 runner/children 继续工作。

这是当前误判最直接的路径。

### Scripted workflow

`workflowScript` 在父 OS process 内的 Node Worker 中运行，并在 Worker 内使用单独 `vm.Context`。它不是 agent，但拥有独立 isolate/realm，所以也不会共享父 realm 的 watchdog `globalThis`。真正的 `runs.run/all` 会 RPC 回 host，再按照 foreground 或 async 路径启动 children。

### Nested/fanout

child Pi 带有 `PI_SUBAGENT_CHILD=1`。完整 pi-subagents parent extension 在 child 中主动退出注册；获得 fanout 权限时只加载一个较窄的 child runtime。nested lifecycle 通过带 capability token 的文件 route、status 和 event projections 汇总。

因此 nested work 的 root ownership 是 orchestrator 的逻辑关系，不等于简单的 OS parent PID 关系，也不能从 watchdog child attachment 推断。

### Resume/revive/recovery

async 模式已有相当完整的 durable 信息：

- `status.json`；
- `events.jsonl`；
- result 文件；
- `process-terminal.json`；
- runner/process instance IDs；
- result watcher；
- `restoreActiveJobs()` 与 stale-run reconciliation。

这些数据足以让 **pi-subagents provider** 恢复自己的 outstanding-work snapshot，但让 watchdog 直接解析它们会造成严重耦合：路径、schema、状态机和清理策略都属于 pi-subagents 私有实现。

## 3.4 已存在但不能直接复用的 `background-work` API

当前 pi-subagents 已导出 `pi-subagents/background-work`：

- 使用 `Symbol.for("pi-subagents.background-work.v1")`；
- provider 提供 `listActiveWork()`、可选 `reconcile()` 和 wake channels；
- consumer 可以 `snapshotBackgroundWork(sessionId)`。

它证明了“provider registry + reconciliation + wake hint”模式在当前 Pi extension 生态内是可行的。

但它不是本问题的直接答案：

1. namespace、package 和协议所有权属于 `pi-subagents`，不够中立；
2. 它仍然是 parent realm 内 registry，本身不是跨进程 transport；
3. pi-subagents 用它等待**其他 provider 的 background work**，没有把自己的 child runs 注册进去；
4. 它的 item 形状只包含 `id/sessionId`，没有 provider readiness、incarnation、revision、unknown/recovering 等本问题需要的故障语义；
5. watchdog 直接 import 它会形成对特定 subagent 插件的依赖。

应该泛化它的模式，而不是直接复用其 namespace/API。

---

## 4. “Idle”真正需要回答什么

正确的问题不是“有没有 child PID”，而是：

> 对于当前 root activity domain，所有已注册且可信的 activity providers 是否都能给出一致快照，并且没有 outstanding logical work？

其中需要区分：

- **Pi agent idle**：当前 Pi agent loop 没在执行、重试、compaction 或处理 queued continuation；
- **process alive**：某个 OS process 仍存在；
- **provider ready**：provider 已完成恢复，能对自己的 work 集合做权威陈述；
- **work outstanding**：逻辑工作尚未 terminal-and-delivered；
- **aggregate ready**：所有 relevant providers 均 ready，且 outstanding 集合为空。

只有最后一个状态可以允许 watchdog 开始 idle delay/decision，或者发布 user-ready。

推荐保留三值/多值状态，而不是强迫所有情况落成 busy/idle：

| Provider 状态 | 含义 | Watchdog 行为 |
|---|---|---|
| `ready + outstanding=[]` | provider 确认没有相关工作 | 可继续检查其他 providers |
| `ready + outstanding!=[]` | 存在 queued/running/paused/delivering 等逻辑工作 | 不启动 decision；等待 hint 后重查 |
| `recovering` | 正在从持久状态恢复 | fail closed；显示恢复中 |
| `unknown/error` | 无法可靠声明空集合 | fail closed；显示错误，允许人工 unlock |

---

## 5. 方案比较

| 方案 | 插件中立性 | 跨进程真相 | restart/crash | 竞态 | 复杂度 | 结论 |
|---|---:|---:|---:|---:|---:|---|
| **A. Parent-main-realm provider registry + snapshot** | 高 | 间接但强：由 owner/orchestrator 汇总 | 单独使用为中；可由 provider 恢复提高 | 好，前提是 exact snapshot/revision 与 decision fencing | 低 | **推荐公开 seam** |
| **B. start/end event protocol** | 高 | 需要 parent relay | 差，除非另加 replay | 易漏 start/end、乱序、重复 | 低起步、高硬化 | 仅做 wake hint |
| **C. 共享文件 lease/journal** | 高 | 合作进程可直接写 | 好 | 需要 epoch、TTL、原子写和清理 | 中高 | 仅作 provider 内部 durable backend |
| **D. Unix socket / Windows named pipe coordinator** | 高 | 强 | coordinator restart 需要协议 | 可用 ack/snapshot 解决 | 高 | 当前过度设计 |
| **E. OS process tree / PID / process group** | 表面高 | 只有进程存在性，没有逻辑语义 | 差；PID reuse/orphan | 根本语义不足 | 中 | **拒绝作为权威** |
| **F. Pi core delegated-work supervisor** | 最高 | 强，若所有 work 经 core 注册 | 可设计为强 | 最佳潜力 | 很高、交付慢 | 长期战略方向 |
| **G. A + provider-specific durable reconciliation** | 高 | 强 | 高 | 好 | 中 | **推荐实际形态** |

## 5.1 A：中立 provider snapshot registry

### 优点

- watchdog 不需要知道 producer 是 pi-subagents、另一个 agent framework、外部 build runner 还是未来插件；
- 不要求 child Pi 加载 watchdog；
- 不要求新的跨平台 daemon；
- producer 已经掌握逻辑状态，转换成本最低；
- snapshot 可修复 missed event；
- provider 内部可以自由升级进程监督或持久化，而不改变 watchdog。

### 单独使用的限制

如果 parent 进程重启后还有 async work 存活，仅靠内存 registry 会丢失状态。因此第一 producer 必须在注册后先恢复并返回 `recovering`，再通过自己的 artifacts/reconciler 提供 ready snapshot。这就是 G。

但“注册后先 recovering”仍不能关闭注册前窗口：registry 为空时，consumer 不知道 provider 不存在，还是应该存在但尚未加载。若要承诺 restart-safe coverage，还需要一个独立的 **expected-provider readiness barrier**，例如 Pi/core 已知资源、显式配置或 session durable marker。没有这个 barrier 时，A/G 只能诚实保证“已成功注册 providers 所报告的 work”，不能证明 absent provider 代表 none。

## 5.2 B：纯事件

LSP 和 DAP 的 progress begin/report/end 说明显式 finite lifecycle 很适合 UI；但事件不是当前状态数据库。Pi `EventEmitter` 也不提供 replay。只计数 start/end 会遇到：

- consumer 晚于 start 注册；
- end 丢失；
- producer reload；
- duplicate completion；
- nested events 乱序；
- start 已发出但 child launch 失败；
- terminal process 已退出但 result 尚未投递。

所以事件只能触发 re-query，不能作为 authoritative count。

## 5.3 C：文件 lease/journal

文件协议可以独立于 Pi 和具体插件，并支持 parent restart，但完整正确实现需要：

- private runtime directory 与权限；
- atomic write/rename；
- coordinator/provider epoch；
- exact work ID；
- monotonic lease deadline；
- heartbeat；
- stale cleanup；
- watcher overflow 后 full rescan；
- Windows 文件/rename 差异；
- clock/reboot 语义；
- 防止旧 writer 覆盖新 incarnation。

这对第一版公开 seam 太重。已有 pi-subagents artifacts 已经实现了该插件需要的 durable 部分，所以更合理的是由其 provider 内部复用，而不是再制造第二套共享文件状态机。

## 5.4 D：socket/pipe coordinator

Unix domain socket 或 Windows named pipe 可以提供：

- register acknowledgment；
- connection-close crash signal；
- snapshot RPC；
- sequence/epoch fencing；
- push hint。

但还需要端点发现、ACL、stale socket 清理、Windows/Linux 两套实现、coordinator 重启、重连和持久恢复。只有当多个真正独立的外部进程需要直接注册，且没有共同 parent orchestrator 时才值得引入。

## 5.5 E：OS process observation

### 为什么 `kill(pid, 0)` / PID 文件不够

- 只能说明某 PID 可能存在或权限不足；
- PID 可复用；
- 无法证明 session ownership；
- runner 存活不等于 work busy，runner 退出也不一定等于 result delivered；
- nested delegation 可能脱离原进程树；
- paused、needs-parent、terminal-undelivered 都无法表达。

### pidfd 的位置

Linux pidfd 能解决 PID reuse，并能 poll 一个具体 process lifetime，是直接 child supervision 的优秀辅助工具。但它 Linux-only，仍然没有 logical-work 语义。Windows Job Objects 同样擅长 containment 和进程组生命周期，不是逻辑任务注册表。

所以 OS primitives 可以放在 provider 内增强 crash detection，不能成为 watchdog 的公共真相来源。

## 5.6 F：Pi core

长期最干净的架构是 Pi 提供中立 delegated-work/activity registry，所有 orchestrator 都注册逻辑工作，watchdog 只消费 core snapshot。

优势是协议所有权和生态一致性最好；缺点是：

- 需要 Pi core API 设计和发布；
- 无法立即修复当前 fork 上的问题；
- core 仍需要 producer/orchestrator 提供语义，不能凭 OS 自动发现。

因此建议先在插件侧验证一个很小的 structural protocol，得到两个真实参与者（watchdog consumer + pi-subagents producer）和故障测试后，再决定是否 upstream 到 core。

---

## 6. 推荐协议性质

以下是设计约束，不建议现在冻结成最终 TypeScript schema。

## 6.1 中立所有权

- 不使用 `pi-subagents:*` namespace；
- watchdog 不 import、探测或命名 pi-subagents；
- producer 只实现 structural contract；
- 协议版本明确；
- 将来可迁移到 Pi core，而不改变产品语义。

## 6.2 Exact identity，而不是计数器

每项 work 至少应由以下元组唯一定位：

```text
provider identity
+ provider incarnation/generation
+ root activity domain
+ provider-local work ID
```

不能只维护 `busyCount++/--`，否则 duplicate end、missed start、reload 和 stale callback 都会破坏计数。

## 6.3 Provider incarnation 与 revision

- provider reload/replacement 必须产生新 incarnation；
- disposer 只能注销它注册的 exact incarnation；
- 每次 snapshot 有单调 revision；
- wake hint 可以携带 revision，但 consumer 始终以最新 snapshot 为准；
- 旧 callback 和旧 completion 不得修改新 provider 状态。

## 6.4 Snapshot 是权威，event 是 hint

```text
provider emits “changed”
  → watchdog invalidates any open idle/decision observation
  → watchdog re-reads full snapshot
  → validates readiness, identity, revision and item set
  → only then recomputes aggregate idle
```

这吸收了 Kubernetes watch/relist、durable job history 和现有 pi-subagents `background-work` 的有价值部分，同时避免把 UI progress event 误当成存储。

Snapshot 也不是天然的跨-provider原子事务。第一版应选择并写清一种可实现边界：

- **优先选择：同步、纯内存、严格 bounded 的 provider snapshot callback**，并在 collect 前后读取 registry aggregate generation；generation 变化则整次 collect 作废重来。同步 callback 无法被 JavaScript 强制 timeout，因此 contract 必须禁止 I/O、等待和长计算，并以开发期耗时诊断约束；或
- 允许异步 snapshot，但必须使用 aggregate generation + double-collect/commit-time validation，任何 callback hang/timeout 都变成 `unknown`。这更灵活，但明显更复杂。

基于简单性，首版公开 registry 更适合前者；文件扫描/reconciliation 应由 provider 在后台提前完成，并通过 `recovering/unknown` 暴露，而不是阻塞 snapshot callback。

## 6.5 显式 readiness/unknown

空数组必须只表示“provider 已确认没有 outstanding work”，不能同时表示：

- provider 还没恢复；
- provider 查询抛错；
- schema 无效；
- provider 消失；
- snapshot 超时。

这些情况必须保留为 `recovering/unknown/error`，watchdog 默认 fail closed。

## 6.6 Root-domain propagation

所有 nested work 必须归属于原 root activity domain，而不是按 child Pi session ID 被拆散。domain ID 的来源和传播应由 orchestrator 决定；watchdog 只按当前 main/root 查询。

## 6.7 Begin-before-launch，end-after-delivery

推荐顺序：

```text
reserve/register work
  → provider snapshot 可见 outstanding item
  → launch child/runner
  → update queued/running/paused/attention 状态
  → observe terminal process/logical outcome
  → deliver result/attention to owning parent
  → mark terminal-and-delivered/remove outstanding item
```

原因：

- 如果先 spawn 再 register，会存在 child 已运行但 snapshot 仍为空的危险窗口；
- process exit 不是完整 terminal contract；结果可能仍未被 parent 接收；
- cancellation 只是请求，不能等同于 completion；
- launch 失败也必须产生明确 terminal outcome，而不是静默删项。

## 6.8 Provider 内部恢复

对于当前 pi-subagents，provider 可以组合：

- foreground `activeChildren` / control maps；
- async `state.asyncJobs`；
- `status.json` 与 stale-run reconciler；
- `process-terminal.json`；
- result watcher 的 delivered/undelivered 状态；
- nested route/status projection。

watchdog 不应直接读取以上任何格式。

## 6.9 只读观察，无控制权

activity protocol 不应让 watchdog 获得 stop、kill、steer、delete artifact 或 reap 权限。它只回答 outstanding 状态。这样可以防止兼容层变成第二个 orchestrator。

## 6.10 不污染 model context

provider 状态、work IDs、恢复错误和 snapshot validation error 应只进入 runtime/TUI observability，不应作为隐藏 user/assistant message进入模型上下文。

---

## 7. 建议的 aggregate-idle 算法

概念算法如下：

```text
on main attachment idle or provider-change hint:
  invalidate/cancel stale idle timer and any open decision observation
  read current watchdog hub snapshot
  identify current root activity domain
  verify expected-provider readiness, if the product promises it
  collect every relevant provider snapshot under one aggregate generation

  if expected provider is absent, or any provider is recovering/unknown/error:
      persist/show activity-check status
      do not arm continuation timer
      do not publish user-ready
      return

  if any exact outstanding item exists:
      do not arm continuation timer
      return

  arm normal watchdog idle delay with the observed aggregate generation

on timer expiry:
  re-check main ownership and Pi aggregate idle
  recollect provider snapshots and aggregate generation
  require all expected providers ready and all item sets empty
  only then enter the watchdog decision flow, fenced to that observation

while decision is open:
  any provider-change hint or aggregate-generation change invalidates it

before every externally visible outcome:
  re-check main ownership, Pi idle, expected-provider readiness,
  aggregate generation, provider readiness and exact outstanding sets
  if anything changed, discard/defer this decision outcome and reconcile again
```

“Externally visible outcome”至少包括：continue、reasoned/terminal unlock、decision-failed、exhausted 和 user-ready publication。必须在 timer expiry 和 outcome commit point 都重读/验证，不能只信 timer 创建时或 decision 开始时的状态。这与 watchdog 当前“作用前再次检查 ownership/idle”的原则一致；具体 generation/token 结构仍是可替换实现。

### Provider 缺席或消失

provider 缺席分三类，不能混为一谈：

1. 产品配置/core 明确不期待 provider：可以按无 provider 处理；
2. expected provider 尚未注册、加载失败或重启后尚未恢复：`unknown`，fail closed；
3. provider 曾注册后未经 clean replacement 消失：`unknown`，fail closed，即使它上次快照为空。

若没有 expected-provider barrier，第 1 与第 2 类不可区分，报告必须把 coverage 限定为“成功注册期间”，不能宣称 restart-safe。

若 provider 曾在当前 domain 报告 outstanding work，随后未经 clean replacement 就消失，推荐保持 `unknown`，直到：

- 同 identity 的新 incarnation 完成恢复；
- provider 明确终止并提交 terminal snapshot；
- 用户手工 unlock；
- 或未来产品契约定义了明确 bounded grace/fail-open 策略。

---

## 8. 故障语义与矩阵

| 故障 | 纯事件/计数后果 | 推荐 snapshot/provider 行为 |
|---|---|---|
| child launch 前 producer 崩溃 | 可能漏 start | reserve-before-launch；未完成 registration 则不声明覆盖 |
| start 已发，launch 失败 | busy 永不归零 | provider 返回 terminal launch-failed，幂等收敛 |
| completion event 丢失 | 永久 busy | wake 只作 hint；full snapshot 修复 |
| consumer 晚注册 | 错过全部旧事件 | 注册后立即 full snapshot |
| producer reload | 旧 callback 修改新状态 | incarnation/generation fencing |
| parent restart，async 仍存活 | 内存状态丢失 | provider 先 `recovering`，从 artifacts/reconciler 恢复 |
| runner crash | 可能无 completion | process-terminal proof/lease expiry 后进入 terminal 或 unknown |
| PID reuse | 误认旧 work 仍活 | 不以 PID 为 identity；Linux 可在 provider 内用 pidfd 辅助 |
| nested child 新增 | 父 count 可能短暂为零 | root-domain exact items；snapshot commit-time recheck |
| cancellation 请求 | 过早删项 | cancellation 不终结；等待 terminal observation |
| child 等待 parent | 容易死锁 | provider 用 `needs-parent` 明示，并由 orchestrator 负责唤醒 parent |
| result 已生成但未投递 | 过早 user-ready | terminal-and-delivered 才移除 outstanding |
| provider 查询抛错/超时 | 错误地当空 | `unknown/error`，fail closed，TUI 可见 |
| provider 晚注册/加载失败 | 空 registry 被误当作 none | expected-provider barrier；否则明确仅保证成功注册期间 |
| provider 曾空闲后异常消失 | 上次空快照被永久信任 | exact incarnation 消失即 `unknown`，除非 clean unregister/replace |
| child 在 decision 期间启动 | 旧 decision 仍执行 continue/unlock/ready | provider generation 变化使 decision stale；outcome commit 前重查 |
| file watcher overflow | 漏变化 | watcher 只 hint；full rescan/snapshot |

---

## 9. 从成熟协议可迁移的规则

## 9.1 LSP / DAP

可迁移：

- stable token/work ID；
- begin/report/end；
- cancellation 与 completion 分离；
- progress 作为用户可见观测。

不可直接迁移：

- progress event 本身没有 replay/ownership lease；
- UI progress 完成不等于 process 或 logical result 已安全交付。

## 9.2 OpenTelemetry

span/trace 很适合诊断 lineage、耗时和失败，但不能做权威 liveness：OpenTelemetry Trace API 明确允许 sampling decision 产生 non-recording span，SDK/export pipeline 也与业务 terminal authority 分离，因此 export delay、drop 或 collector failure 不能被解释为 work absence。可以将来作为观测辅助，不能决定 watchdog idle。

## 9.3 systemd watchdog

可迁移：

- 明确区分 readiness、liveness 和业务工作状态；
- heartbeat 只证明 holder 活着，不证明任务完成；
- sender identity/credentials 和超时必须明确。

## 9.4 Kubernetes Lease

最有价值的规则（对应 Kubernetes Lease 的 `holderIdentity`、`renewTime`、`leaseDurationSeconds`、`leaseTransitions` 字段，以及 Kubernetes API 的 resourceVersion/watch 后重新 list 语义）：

- `holderIdentity`；
- renew time / duration；
- incarnation/transitions；
- snapshot + watch + relist；
- stale owner 不能覆盖新 owner。

对本项目而言，完整 Lease 只在 provider 需要跨 parent restart/独立 writer 时使用；公开 registry 不必强制所有 provider heartbeat。

## 9.5 Celery / Temporal

可迁移（Celery 的 late acknowledgement/redelivery 配置以及 Temporal 的 Activity heartbeat、retry policy 和 Event History 分别体现这些区别）：

- acknowledged、running、terminal 是不同阶段；
- crash/retry/redelivery 会让“process exit”与“logical completion”分离；
- durable history/reconciliation 比一次性 event 更可靠；
- heartbeat 只更新活性，不应伪造 terminal state。

---

## 10. 跨平台、安全与性能

## 10.1 跨平台

推荐 A/G 的公开部分只运行在父 JS realm，天然跨平台。provider 内部可以按平台选择：

- Node `ChildProcess` 的 `error/exit/close`；
- Linux pidfd（可选增强）；
- Windows Job Objects（可选 containment）；
- 已有状态文件/runner proof；
- 将来才考虑 Unix socket/Windows named pipe。

不应把 pidfd 或 Job Objects 放入公开 contract。

## 10.2 安全

Pi packages 本身是受信任、拥有完整本机权限的代码，因此 registry 不是恶意插件隔离边界。但仍应防止普通错误：

- 限制 provider 数、item 数、ID 长度和错误文本；
- 验证纯数据，不接受意外 prototype/函数字段作为 snapshot 数据；
- exact disposer/incarnation；
- snapshot callback 必须同步、无 I/O、严格 bounded；开发期记录/报告超预算，不能虚构可强制中断的同步 timeout；若采用异步 callback，则 timeout 必须转成 `unknown` 并配套 aggregate generation/double-collect；
- provider failure 不得被吞成空快照；
- 不暴露控制/kill 能力；
- 若未来使用 socket/file，必须使用用户私有 runtime directory 与严格权限。

## 10.3 性能

正常路径不需要高频 polling：

- lifecycle/event/file watcher 只发 changed hint；
- hint 后读取一次 snapshot，并递增/观察 aggregate generation；
- idle timer expiry 和 decision outcome commit 各做一次 validation snapshot；
- provider 自己决定是否需要低频 reconciliation。

工作集通常很小，exact item set 比计数器更安全，成本可以忽略。

---

## 11. 推荐 rollout（若之后另行授权）

### Phase 1：先冻结行为，不写集成

通过 ATDD 明确：

- “all observable work”的 truthful scope；
- provider unknown 时 fail-closed/fail-open；
- parent restart promise；
- queued/paused/needs-parent/terminal-undelivered 是否 blocking；
- scheduled future work 的边界；
- TUI observability。

### Phase 2：实现中立 registry 的 isolated tests

至少覆盖：

- provider register/dispose/replacement；
- exact IDs 与 duplicate update；
- incarnation/revision fencing；
- ready/recovering/unknown；
- late subscriber full snapshot；
- malformed/throwing provider；
- timer expiry 与 decision outcome commit-time recheck；
- decision 期间 provider/new child 变化导致旧 outcome 作废；
- provider late registration、load failure、quiet-then-disappear；
- full restart before provider registration；
- expected-provider barrier 或明确 absence limitation；
- reload stale callback。

### Phase 3：watchdog 仅消费中立 seam

要求：

- watchdog 不出现 `pi-subagents` 字符串、import、路径或 schema；
- provider busy/unknown 或 expected provider absent 时不启动 decision；
- decision 期间 provider generation/item 变化时，旧 decision outcome 不得产生 continue/unlock/user-ready；
- provider 清空后重新走正常 idle delay；
- 所有状态只进入 TUI/runtime，不进 model context。

### Phase 4：在 pi-subagents fork 实现第一个 provider

按顺序覆盖：

1. foreground single/parallel；
2. async single/parallel/workflow；
3. nested fanout；
4. detach/stop/timeout/failure；
5. result terminal-but-undelivered；
6. reload/restart recovery；
7. scheduled run launch reservation。

### Phase 5：packed/process-level acceptance

关键场景：

- parent settles while async child still running，watchdog 不询问；
- nested child 启动/结束的瞬间没有空窗口；
- completion hint 丢失后 snapshot 仍收敛；
- provider reload 时旧 completion 无法清掉新 work；
- provider 尚未注册、加载失败、曾空闲后异常消失时不会被当作 none；
- full parent restart 在 provider registration 前不会抢先 decision（若承诺 restart safety）；
- parent reload 后 provider recovering，watchdog fail closed；
- recovery 完成并为空后，正常 idle delay 才开始；
- child 在 decision 期间启动会使 decision stale，任何旧 continue/unlock/user-ready outcome 均被丢弃；
- provider error 有持久 TUI 可见性，manual unlock 仍可用；
- 产品明确不期待 provider 时，watchdog 保持当前 same-process 行为；若无法建立 expected-provider barrier，则测试与文档明确 coverage 只从 provider 成功注册起生效。

### Phase 6：再评估 Pi core

只有在协议经过两个真实插件和故障测试验证后，再决定：

- upstream 到 Pi core；
- 抽成独立 package；
- 或继续作为 structural global registry。

当前不建议先建 daemon 或独立服务。

---

## 12. 需要用户决定的产品问题

以下不是纯技术实现细节，开始改代码前应确认：

1. **Truthful scope：** 是否接受保证范围为“当前 root activity domain 下，由合作 providers 报告的 work”？若要求覆盖任意不合作进程，只能转向更大的 Pi-core 强制 supervisor。
2. **Unknown policy：** provider recovering、抛错、返回 malformed snapshot 或异常消失时，是否按推荐 fail closed？
3. **Restart promise：** main Pi 重启后仍存活的 async work，是否必须继续阻止 resumed session 的 watchdog decision？若是，还必须决定 expected-provider barrier 的权威来源（Pi/core、显式配置或 session durable marker）；单纯等 provider 注册后返回 recovering 不足以覆盖注册前窗口。
4. **Outstanding 定义：** 是否采用最安全的“所有尚未 terminal-and-delivered 的 queued/running/nested/paused/needs-parent/delivering work 都 blocking”？
5. **Scheduled work：** 是否只在到期并完成 launch reservation 后 blocking，而不是未来 schedule 创建时就一直 blocking？
6. **Needs-parent：** child 需要 parent attention 时，是否由 orchestrator 单独负责唤醒 parent，而 watchdog 继续保持 blocked？这是推荐方案，可避免两个调度器抢控制权。
7. **Protocol ownership：** 第一版是 watchdog-owned structural protocol、以后提议给 Pi core，还是必须先等 Pi core API？当前推荐前者。
8. **First adapter：** 是否允许单独修改 `xz-dev/pi-subagents-nicobailon` 作为第一个 producer，前提是 watchdog 对其保持零 import、零命名、零私有路径依赖？这是修复当前问题的最短路径。

---

## 13. 最终建议

### 应做

采用 **A/G hybrid**：

- 中立、版本化、parent-main-realm 的 provider snapshot registry；它通过 providers 间接汇总跨进程事实，而不是跨 Worker/进程共享 `globalThis`；
- provider 是逻辑真相所有者；
- snapshot 是权威，event 只是 wake hint；
- exact work identities + provider incarnation/revision + aggregate decision fencing；
- explicit ready/recovering/unknown，以及对 expected-provider absence 的诚实处理；
- root-domain propagation；
- begin-before-launch；
- terminal-and-delivered 才结束；
- provider 内部负责 durable reconciliation；
- watchdog unknown 时 fail closed，并有清楚 TUI；
- 将来有真实生态需求再 upstream 到 Pi core。

### 不应做

- watchdog 直接订阅 `subagent:*` 私有 channels 并自己计数；
- watchdog import `pi-subagents/background-work`；
- watchdog 直接解析 `.pi-subagents`、`status.json` 或 result artifacts；
- 依赖 PID、`kill(pid, 0)`、进程树或 process group 判断 logical idle；
- 第一版引入本地 daemon/socket broker；
- 把 OpenTelemetry span 或 UI progress 当成权威 liveness；
- provider 出错时静默按“没有 work”继续；
- 给 watchdog 增加 stop/kill/steer subagent 的控制权。

### 一句话结论

> 最简单且可靠的方向不是让 watchdog 跨进程“猜”child agent，而是让每个 orchestrator 在父进程中通过一个中立的、可恢复的 snapshot provider，回答它自己拥有的 delegated work 是否仍 outstanding。

---

## 14. 主要来源

### 本地项目源码

- `pi-continue-watchdog/src/hub.ts` — process-local hub、same-realm `Symbol.for`、busy/idle aggregation。
- `pi-continue-watchdog/src/runtime.ts` — `session_start`、`agent_start`、`agent_settled` 与 idle recheck。
- `pi/packages/coding-agent/src/core/event-bus.ts` — `pi.events` 基于 Node `EventEmitter`。
- `pi-subagents/src/runs/foreground/execution.ts` — foreground child Pi process spawn/lifecycle。
- `pi-subagents/src/runs/background/async-execution.ts` — detached runner spawn、process terminal proof。
- `pi-subagents/src/runs/background/subagent-runner.ts` — runner 启动实际 Pi writer。
- `pi-subagents/src/runs/background/async-job-tracker.ts` — parent async state、restore/reconciliation。
- `pi-subagents/src/runs/background/process-terminal.ts` — terminal proof。
- `pi-subagents/src/runs/background/result-watcher.ts` — terminal result delivery与恢复。
- `pi-subagents/src/runs/shared/nested-events.ts` — nested route、root lineage 与 capability。
- `pi-subagents/src/api/background-work.ts` — 已有 package-owned provider registry 模式。

### Pi 官方/项目文档

- [Pi extension documentation](https://github.com/xz-dev/pi/blob/4bf91cbf5ae62b4a4f9f764a978aab5600a18f98/packages/coding-agent/docs/extensions.md)
- [Pi EventBus implementation](https://github.com/xz-dev/pi/blob/4bf91cbf5ae62b4a4f9f764a978aab5600a18f98/packages/coding-agent/src/core/event-bus.ts)

### Node / OS / storage

- [Node.js ChildProcess](https://nodejs.org/api/child_process.html#class-childprocess)
- [Node.js `fs.watch`](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)
- [Linux `kill(2)`](https://man7.org/linux/man-pages/man2/kill.2.html)
- [Linux `pidfd_open(2)`](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- [Linux `pidfd_send_signal(2)`](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html)
- [Linux Unix-domain sockets](https://man7.org/linux/man-pages/man7/unix.7.html)
- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Linux `inotify(7)`](https://man7.org/linux/man-pages/man7/inotify.7.html)
- [Microsoft Named Pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes)
- [Microsoft Named Pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite locking](https://www.sqlite.org/lockingv3.html)
- [XDG Base Directory specification](https://specifications.freedesktop.org/basedir-spec/latest/)

### 生命周期与协调协议

- [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/specification)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
- [OpenTelemetry Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [systemd `sd_notify`](https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html)
- [systemd watchdog](https://www.freedesktop.org/software/systemd/man/latest/sd_watchdog_enabled.html)
- [Kubernetes Lease](https://kubernetes.io/docs/concepts/architecture/leases/)
- [Kubernetes Lease API v1](https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/lease-v1/)
- [Celery task semantics](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
- [Temporal Activity heartbeats](https://docs.temporal.io/develop/python/failure-detection#activity-heartbeats)
- [Temporal Event History](https://docs.temporal.io/encyclopedia/event-history)

## 16. Supersession: implemented authenticated broker architecture

The earlier same-process-only conclusion in this report is superseded for watchdog-loaded inherited Pi processes by the reviewed `xz-dev/pi-process-domain` architecture.

The shipped design uses one process-wide watchdog coordinator participant, exact local attachment aggregation, and one authenticated embedded protocol-v2 broker per root Pi domain on a private Unix socket/named pipe, with immutable certain/all-idle snapshots and confirmation fences. Only the domain-creating root PID owns watchdog decisions while that broker is open; inherited processes connect as observers and cannot create or revive it. Final root detach clears the creator marker and closes the endpoint, so a later root attachment creates a fresh isolated domain. The root decision run suppresses only its own artificial busy state, while any other activity invalidates its fence and folds the stale exchange.

Guarantee boundaries remain explicit: observation is strict after inherited watchdog `session_start`; zero-gap launch coverage requires `reserveSpawn()` cooperation; stripped/replaced environment declarations and children that do not load watchdog cannot be observed.
