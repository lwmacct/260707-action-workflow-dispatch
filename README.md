# Dispatch Workflow

在一个 workflow 中触发另一个 GitHub Actions workflow，并把当前 tag/sha 上下文标准化后转发过去。

这个 Action 主要用于这类发布模式：

```text
tag push or manual release workflow
  -> dispatch publish workflow on main/default branch
  -> publish workflow checkout and validates the release tag commit
```

这样可以让真正的发布 workflow 固定运行在主分支或默认分支上，避免不同 tag ref 之间的 cache 作用域隔离，同时保留发布端对 tag/sha 的二次校验。

## 基本用法

```yaml
name: release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      tag:
        required: true
        type: string
      sha:
        required: false
        type: string

permissions:
  actions: write
  contents: read

jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - uses: lwmacct/260707-action-workflow-dispatch@main
        with:
          workflow: publish.yml
          ref: main
          tag: ${{ inputs.tag }}
          sha: ${{ inputs.sha }}
          tag-pattern: "v*"
```

在 tag push 事件中，`tag` 和 `sha` 可以省略：

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    ref: main
    tag-pattern: "v*"
```

## 额外 inputs

`inputs` 支持一行一个 `key=value`，会追加为目标 workflow 的 `workflow_dispatch` input。

```yaml
- uses: lwmacct/260707-action-workflow-dispatch@main
  with:
    workflow: publish.yml
    ref: main
    inputs: |
      environment=production
      channel=stable
```

默认会把解析出的 tag 和 sha 转发为目标 workflow 的 `tag` 和 `sha` inputs。可以通过 `tag-input` 和 `sha-input` 改名；设为空可以禁用对应字段。

## Inputs

| 名称 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `workflow` | 是 |  | 目标 workflow 文件名、ID 或 `gh workflow run` 可接受的名称 |
| `ref` | 否 | 仓库默认分支，取不到时为 `main` | 目标 workflow 运行在哪个 ref 上 |
| `repository` | 否 | 当前仓库 | 目标仓库，格式为 `owner/repo` |
| `github-token` | 否 | `${{ github.token }}` | 调用 `gh workflow run` 使用的 token |
| `tag` | 否 | tag push 事件的 ref name | 要转发的 tag |
| `sha` | 否 | tag push 事件的 `GITHUB_SHA` | 要转发的 commit SHA |
| `require-tag` | 否 | `true` | 没有解析到 tag 时是否失败 |
| `tag-pattern` | 否 |  | 可选 tag glob，例如 `v*` |
| `tag-input` | 否 | `tag` | 目标 workflow 接收 tag 的 input 名；空值表示不转发 |
| `sha-input` | 否 | `sha` | 目标 workflow 接收 sha 的 input 名；空值表示不转发 |
| `inputs` | 否 |  | 额外目标 workflow inputs，一行一个 `key=value` |
| `summary` | 否 | `true` | 是否写入 GitHub Step Summary |

## Outputs

| 名称 | 说明 |
| --- | --- |
| `workflow` | 目标 workflow |
| `ref` | 解析后的目标 ref |
| `repository` | 解析后的目标仓库 |
| `tag` | 解析后的 tag |
| `sha` | 解析后的 SHA |

## 权限

调用方 workflow 需要允许触发 workflow：

```yaml
permissions:
  actions: write
  contents: read
```

目标 workflow 必须支持 `workflow_dispatch`。
