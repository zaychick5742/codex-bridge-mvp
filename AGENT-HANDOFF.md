# Codex Bridge MVP Agent Handoff

这份文档给 `openclaw supervisor / agent` 使用，目的是让上层调度方在不阅读实现细节的前提下，直接理解这个项目的用途、接口、运行方式、边界和当前能力。

## 1. 项目是做什么的

这个项目是 `openclaw` 和 `codex CLI` 之间的本地桥接层。

它的职责是：

- 把 `codex exec --json` 封装成一个可控、可查询、可续推、可冻结结果的本地 daemon。
- 把 worker 运行过程沉淀为结构化状态，而不是让 supervisor 读终端屏幕。
- 用“分轮执行”的方式管理 worker：每一轮都是一次新的非交互 `codex exec`。
- 在每轮结束后重算代码 diff、验证结果、进展状态和是否需要继续。

它明确 **不是**：

- 共享长期会话 worker。
- TTY watcher。
- AppleScript/终端屏幕读取方案。
- `cliproxyapi` 的一部分。
- 多 worker 调度器。

## 2. 当前架构

当前 MVP 架构固定为：

- `openclaw` 充当 supervisor。
- `codex-bridge-mvp` 充当 control plane。
- `codex exec --json` 充当单 worker。

控制关系：

1. `openclaw` 调 `start`
2. `bridge` 启动一轮 `codex exec --json`
3. `openclaw` 周期性调 `query`
4. 如果状态是 `waiting`，`openclaw` 决定是否 `continue`
5. 如果状态是 `needs_guidance`，上抛给人或更高层 agent
6. 如果状态是 `blocked`，停止自动推进
7. 如果状态是 `done`，调用 `finalize`

## 3. Worker 运行方式

MVP 只支持这一种 worker 启动方式：

```bash
codex exec --json --full-auto --cd <cwd> <prompt>
```

说明：

- 每一轮都是全新的非交互进程。
- 不使用 `resume`。
- 不使用 `fork`。
- `continue` 的实现方式是重新拼 prompt，再起新一轮 `exec`。

`continue` 轮的 prompt 由这些信息拼成：

- 原始任务 `task_prompt`
- 原始验收条件 `acceptance[]`
- 原始策略边界 `allowed_commands[]`
- 原始停止条件 `stop_conditions[]`
- 上一轮摘要
- 当前 `diff_status`
- 当前 `test_results`
- 最近执行过的命令
- 上一轮未完成项

## 4. Public Interface

daemon 默认以前台方式启动，默认监听：

```text
http://127.0.0.1:4545
```

当前暴露的 HTTP 接口如下。

### `POST /start`

输入固定为：

```json
{
  "task_prompt": "string",
  "cwd": "/abs/path/to/repo",
  "acceptance": ["string"],
  "allowed_commands": ["git", "npm", "node"],
  "stop_conditions": ["string"]
}
```

返回值：

```json
{
  "run_id": "uuid",
  "query": {
    "status": "running",
    "judgement": "working",
    "summary": "Round 1 is running.",
    "diff_status": "error",
    "test_results": "not_run",
    "round": 1,
    "stall_count": 0,
    "last_error": null
  }
}
```

### `GET /query?run_id=<id>`

也支持：

```json
POST /query
{
  "run_id": "uuid"
}
```

输出固定为：

```json
{
  "status": "running | waiting | needs_guidance | blocked | done",
  "judgement": "working | acceptance_partial | ready_to_finalize | needs_guidance | blocked | finalized",
  "summary": "string",
  "diff_status": "clean | changed | no_repo | error",
  "test_results": "passed | failed | not_run | error",
  "round": 1,
  "stall_count": 0,
  "last_error": null
}
```

### `POST /continue`

输入：

```json
{
  "run_id": "uuid"
}
```

约束：

- 只有在 `status == waiting` 时允许。
- 如果 run 已 `finalized`，不允许继续。
- 当前只允许单活跃 worker，已有 worker 在跑时不会同时启动第二个。

### `POST /interrupt`

输入：

```json
{
  "run_id": "uuid"
}
```

行为：

- 终止当前 worker 进程。
- 保留现场状态和日志。
- run 进入 `blocked`，`last_error = interrupted_by_user`。

### `POST /finalize`

输入：

```json
{
  "run_id": "uuid"
}
```

约束：

- 只有在 `status == done` 时允许。
- finalize 后写入 `final.json`。
- finalize 后 `judgement` 会变成 `finalized`。
- finalize 后不允许再 `continue`。

### `GET /health`

健康检查接口：

```json
{
  "ok": true
}
```

## 5. 事件流

所有事件统一写入：

```text
.bridge-state/<run_id>/events.jsonl
```

每条事件至少有：

```json
{
  "ts": "ISO time",
  "run_id": "uuid",
  "round": 1,
  "type": "worker.event",
  "payload": {}
}
```

Bridge 当前会产出这些归一化事件类型：

- `run.created`
- `worker.started`
- `worker.event`
- `worker.stderr`
- `worker.stdout`
- `worker.exited`
- `diff.snapshot`
- `tests.snapshot`
- `judgement.updated`
- `run.finalized`

说明：

- `worker.event` 是从 `codex exec --json` stdout 成功解析出的 JSON 事件。
- `worker.stderr` 是 stderr 的逐行诊断事件。
- `worker.stdout` 是 stdout 中无法解析成 JSON 的文本行。
- stdout 的非 JSON 文本不会破坏事件解析。

## 6. 状态目录约定

每个 run 固定落在：

```text
.bridge-state/<run_id>/
```

包含：

- `spec.json`
- `state.json`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `final.json`
- `pid`

各文件含义：

- `spec.json`: `start` 原始输入契约
- `state.json`: 当前 run 的主状态
- `events.jsonl`: 结构化事件流
- `stdout.log`: worker stdout 原始文本日志
- `stderr.log`: worker stderr 原始文本日志
- `final.json`: finalize 后冻结的最终结论
- `pid`: 当前活跃 worker pid，无活跃进程时写空

## 7. 对外状态和判定

### 对外状态 `status`

- `running`
  说明 worker 仍在运行，或 bridge 正在做本轮收尾分析。
- `waiting`
  说明本轮已结束，但还未满足完成条件，仍可自动续推。
- `needs_guidance`
  说明 worker 明确请求决策，或连续 2 轮无实质进展。
- `blocked`
  说明出现启动失败、环境故障、策略越界、人工中断，或连续 3 轮无实质进展。
- `done`
  说明 run 满足完成条件，可进入 finalize。

### 对外判定 `judgement`

- `working`
- `acceptance_partial`
- `ready_to_finalize`
- `needs_guidance`
- `blocked`
- `finalized`

## 8. 完成判定规则

当前 Bridge 只有在同时满足这些条件时，才会把 run 置为 `done`：

- 有代码改动，即 `diff_status == changed`
- 至少有 1 个关键验证命令通过，即 `verification_status == passed`
- 没有明显未收口项
- `stop_conditions[]` 没有要求必须继续

当前 `test_results` 只代表测试类命令结果，`done` 实际使用的是更宽的 `verification_status`。

## 9. 无进展与升级规则

Bridge 会在轮结束后判断本轮是否有“实质进展”。

当前判断依据包括：

- `diff_fingerprint` 是否变化
- `verification_status` 是否前进
- worker 最终摘要是否和上一轮实质相同

升级规则：

- 连续 2 轮无实质进展 -> `needs_guidance`
- 连续 3 轮无实质进展 -> `blocked`

## 10. allowed_commands 的处理方式

`allowed_commands[]` 当前不是内核级沙箱，只是任务契约 + 事后审计。

实现方式：

1. Bridge 把 `allowed_commands[]` 写进 worker prompt
2. Bridge 解析 `command_execution` 事件里的 shell 命令
3. 提取命令 basename 列表
4. 发现超出白名单时，立即标记 `blocked_policy`
5. Bridge 终止该轮 worker，run 进入 `blocked`

说明：

- 当前是 basename 级校验，不是完整 shell AST 安全策略。
- 这足够支撑 MVP 的“越界发现即阻塞”。

## 11. diff 与 test 结果的来源

### diff

每轮结束后 Bridge 会运行 git 检查：

- 如果不是 git repo -> `no_repo`
- 如果工作树无改动 -> `clean`
- 如果有改动 -> `changed`
- git 检查报错 -> `error`

并记录一个 `diff_fingerprint` 作为进展判定依据。

### test_results

Bridge 会从 worker 实际执行过的命令中识别测试类命令，例如：

- `npm test`
- `node --test`
- `pytest`
- `jest`
- `vitest`
- `go test`
- `cargo test`

结果聚合为：

- `passed`
- `failed`
- `not_run`
- `error`

### verification_status

Bridge 还会识别更宽的验证命令，例如：

- 测试命令
- `lint`
- `build`
- `typecheck`
- `check`
- `verify`
- `tsc`
- `eslint`
- `ruff`

`done` 的判定依赖这个更宽的验证状态，而不是只看 `test_results`。

## 12. 当前已实现的边界

当前 MVP 明确只支持：

- 单项目
- 单 worker
- 本地状态目录
- 单机 `localhost` 控制面
- 分轮非交互 worker

当前 **不支持**：

- 长期共享同一个 `codex` 会话线程
- `resume/fork` 持久 worker
- 多 worker 并发
- terminal watcher
- 读屏幕内容
- 基于 `cliproxyapi` 的桥接接入

## 13. 与 openclaw supervisor 的协作契约

`openclaw` 不应读取 worker 终端或推断 TTY 内容。

它应该只通过 daemon 接口驱动：

1. 调 `start`
2. 周期性 `query`
3. `status == waiting` 时，按自身策略决定是否 `continue`
4. `status == needs_guidance` 时，停止自动续推并上抛
5. `status == blocked` 时，停止自动续推
6. `status == done` 时，调 `finalize`

建议的最小 supervisor 策略：

- query 轮询间隔 1 到 3 秒
- `waiting` 时优先检查 `summary`、`diff_status`、`test_results`
- 不要在 `running` 时重复 `continue`
- 不要在 `done` 之前调用 `finalize`

## 14. 项目文件结构

核心文件如下：

- `src/cli.ts`
  CLI 入口，负责启动 daemon 和 smoke。
- `src/daemon.ts`
  HTTP 控制面、run 生命周期、worker 管理、事件采集、状态持久化。
- `src/analyze.ts`
  diff/test/verification 聚合、guidance 检测、完成/阻塞/等待判定。
- `src/prompt.ts`
  初轮 prompt 和续推 prompt 的拼装。
- `src/shell.ts`
  shell 命令抽取、allowed_commands 审计、test/verification 命令识别。
- `src/smoke.ts`
  端到端 smoke。
- `fixtures/toy-repo`
  smoke 用 toy repo。

## 15. 如何运行

安装与构建：

```bash
cd <repo-root>
npm install
npm run build
```

启动 daemon：

```bash
npm run daemon
```

也可以直接：

```bash
node dist/cli.js daemon --host 127.0.0.1 --port 4545
```

运行 smoke：

```bash
npm run smoke
```

## 16. 当前已验证范围

已经实际验证过：

- daemon 可启动
- `start/query/continue/interrupt/finalize` 全链路可用
- `codex exec --json` 事件可解析
- stdout/stderr 混合采集不会破坏 JSON 事件流
- 首轮可进入 `waiting`
- supervisor 风格的 `continue` 可触发下一轮
- 满足条件后可进入 `done`
- `finalize` 会冻结最终结果
- `interrupt` 可把运行中 worker 置为 `blocked`
- 策略越界会触发 `blocked_policy`

## 17. 当前已知限制

这些是当前故意保留的 MVP 限制，不是 bug：

- `allowed_commands[]` 是事后审计，不是系统级限制
- `needs_guidance` / “未收口项” / “关键检查通过” 仍有启发式成分
- 只允许单活跃 worker
- `query` 返回的是固定摘要视图；更细粒度信息需要读 `state.json` 或 `events.jsonl`

## 18. 推荐的下一步

如果要进入真实联调，建议顺序如下：

1. 让 `openclaw supervisor` 直接接这 5 个接口
2. 先复用 toy repo 跑一遍 supervisor 自动续推
3. 再切一个真实仓库任务
4. 观察 `needs_guidance` 和 `blocked` 的触发是否符合预期
5. 再决定是否进入二期能力：`resume/fork`、多 worker、长期会话

## 19. 一句话总结

这个项目已经把 `codex exec --json` 封装成了一个可由 `openclaw` 监督和续推的本地 round-based worker control plane；上层现在只需要通过结构化接口驱动它，不需要碰终端屏幕。
