# Dispatch Workflow

触发一个 `workflow_dispatch` workflow，并转发最小发布对象：`source-tag` 和 `source-sha`。

## 最小用法

tag push 触发时，只需要指定目标 workflow：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
```

Action 会自动推断：

- `target-repository`: 当前仓库
- `target-ref`: 目标仓库默认分支，取不到时为 `main`
- `source-tag`: 当前 tag ref
- `source-sha`: tag push 事件的 `GITHUB_SHA`

## 手动入口

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    source-tag: ${{ inputs.tag }}
    source-sha: ${{ inputs.sha }}
```

## 目标 workflow

目标 workflow 只需要声明：

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

额外 inputs 用 `inputs` 显式传递：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    inputs: |
      environment=production
      channel=stable
```

## 跨仓库调度

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    target-repository: lwmacct/deploy-workflows
    target-ref: main
    token: ${{ secrets.DEPLOY_WORKFLOW_TOKEN }}
```

`token` 需要对目标仓库有 Actions write 权限。

## 等待目标 run

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
| `target-ref` | 否 | 目标默认分支，取不到时 `main` | 目标 workflow 运行 ref |
| `token` | 否 | `${{ github.token }}` | 调用 GitHub Actions API 的 token |
| `source-tag` | 否 | 当前 tag ref | source release tag |
| `source-sha` | 否 | tag push 的 `GITHUB_SHA` | 可选 source commit SHA |
| `require-tag` | 否 | `true` | 没有 source tag 时是否失败 |
| `tag-pattern` | 否 |  | source tag glob，例如 `v*` |
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
| `source-tag` | source tag |
| `source-sha` | source SHA |
| `dispatch-id` | 生成的 dispatch ID |
| `run-id` | 等待模式下找到的目标 run ID |
| `run-url` | 等待模式下找到的目标 run URL |
| `status` | 等待模式下的目标 run 状态 |
| `conclusion` | 等待模式下的目标 run 结论 |
