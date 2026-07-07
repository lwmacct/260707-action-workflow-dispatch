# Dispatch Workflow

触发一个 `workflow_dispatch` workflow，并把发布对象最小信息转发过去。默认适合同仓库 tag 发布，也支持跨仓库调度。

## 最小用法

tag push 触发时，只需要指定目标 workflow：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
```

Action 会自动推断：

- `target-repository`: 当前仓库
- `target-ref`: 当前仓库默认分支，取不到时为 `main`
- `source-repository`: 当前仓库
- `source-tag`: 当前 tag ref
- `source-sha`: tag push 事件的 `GITHUB_SHA`

默认只向目标 workflow 转发：

```text
source-tag
source-sha
```

## 跨仓库调度

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    target-repository: lwmacct/deploy-workflows
    target-ref: main
    forward: standard
    token: ${{ secrets.DEPLOY_WORKFLOW_TOKEN }}
```

`token` 需要对目标仓库有 Actions write 权限。经典 PAT 通常需要 `repo` scope；fine-grained token 需要目标仓库的 Actions write 权限。

## 目标 workflow inputs

默认最小目标 workflow 只需要声明：

```yaml
on:
  workflow_dispatch:
    inputs:
      source-tag:
        required: true
        type: string
      source-sha:
        required: false
        type: string
```

跨仓库发布需要 source 仓库信息时，设置 `forward: standard`，目标 workflow 再声明：

```yaml
on:
  workflow_dispatch:
    inputs:
      source-repository:
        required: true
        type: string
      source-tag:
        required: true
        type: string
      source-sha:
        required: false
        type: string
      source-base-ref:
        required: false
        type: string
```

额外 inputs 可以用 `inputs` 传递：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    inputs: |
      environment=production
      channel=stable
```

## 等待目标 run

默认只负责发起 dispatch。需要让当前 workflow 等待目标 workflow 完成时：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    wait: "true"
```

等待模式会轮询目标 workflow 的最新 `workflow_dispatch` run。并发很高时，建议让目标 workflow 的 `run-name` 包含一个稳定标识，并通过 `run-name-contains` 过滤。

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `workflow` | 是 |  | 目标 workflow 文件名或 ID |
| `target-repository` | 否 | 当前仓库 | 目标 workflow 所在仓库 |
| `target-ref` | 否 | 默认分支，取不到时 `main` | 目标 workflow 运行 ref |
| `token` | 否 | `${{ github.token }}` | 调用 GitHub Actions API 的 token |
| `source-repository` | 否 | 当前仓库 | source tag 所在仓库 |
| `source-tag` | 否 | 当前 tag ref | source release tag |
| `source-sha` | 否 | tag push 的 `GITHUB_SHA` | 可选 source commit SHA |
| `source-base-ref` | 否 | 当前默认分支 | 转发给目标 workflow 的 source base ref |
| `require-tag` | 否 | `true` | 没有 source tag 时是否失败 |
| `tag-pattern` | 否 |  | source tag glob，例如 `v*` |
| `forward` | 否 | `minimal` | `minimal` 转发 `source-tag/source-sha`；`standard` 额外转发 `source-repository/source-base-ref` |
| `inputs` | 否 |  | 额外目标 workflow inputs，一行一个 `key=value` |
| `wait` | 否 | `false` | 是否等待目标 workflow 完成 |
| `wait-timeout-seconds` | 否 | `1800` | 等待超时 |
| `wait-interval-seconds` | 否 | `10` | 轮询间隔 |
| `fail-on-target-failure` | 否 | `true` | 目标 run 非 success 时是否失败 |
| `run-name-contains` | 否 |  | 等待时用于筛选目标 run 的标题片段 |
| `dispatch-id-input` | 否 |  | 可选目标 input 名，用于接收生成的 dispatch ID |
| `summary` | 否 | `true` | 是否写入 Step Summary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `workflow` | 目标 workflow |
| `target-repository` | 目标仓库 |
| `target-ref` | 目标 ref |
| `source-repository` | source 仓库 |
| `source-tag` | source tag |
| `source-sha` | source SHA |
| `source-base-ref` | source base ref |
| `dispatch-id` | 生成的 dispatch ID |
| `run-id` | 等待模式下找到的目标 run ID |
| `run-url` | 等待模式下找到的目标 run URL |
| `status` | 等待模式下的目标 run 状态 |
| `conclusion` | 等待模式下的目标 run 结论 |
