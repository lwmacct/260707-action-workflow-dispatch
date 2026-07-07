import * as core from "@actions/core";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";

interface Inputs {
  workflow: string;
  targetRepository: string;
  targetRef: string;
  token: string;
  sourceRepository: string;
  sourceTag: string;
  sourceSha: string;
  sourceBaseRef: string;
  requireTag: boolean;
  tagPattern: string;
  forward: "minimal" | "standard";
  extraInputs: string;
  wait: boolean;
  waitTimeoutSeconds: number;
  waitIntervalSeconds: number;
  failOnTargetFailure: boolean;
  runNameContains: string;
  dispatchIdInput: string;
  summary: boolean;
}

interface ResolvedDispatch {
  workflow: string;
  targetRepository: string;
  targetRef: string;
  sourceRepository: string;
  sourceTag: string;
  sourceSha: string;
  sourceBaseRef: string;
  dispatchId: string;
  fields: Record<string, string>;
  dispatchedAt: Date;
  targetRun?: WorkflowRun;
}

interface GitHubEventPayload {
  repository?: {
    default_branch?: unknown;
  };
}

interface RepositoryResponse {
  default_branch?: string;
}

interface WorkflowRun {
  id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  display_title?: string;
  head_branch?: string;
  event?: string;
  created_at?: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const resolved = await resolveDispatch(inputs);
    await createWorkflowDispatch(inputs, resolved);

    if (inputs.wait) {
      resolved.targetRun = await waitForWorkflowRun(inputs, resolved);
      if (inputs.failOnTargetFailure && resolved.targetRun.conclusion !== "success") {
        throw new Error(`Target workflow concluded with ${resolved.targetRun.conclusion ?? "unknown"}`);
      }
    }

    setOutputs(resolved);
    if (inputs.summary) {
      await writeSummary(resolved);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : "Unexpected failure");
  }
}

function getInputs(): Inputs {
  const workflow = core.getInput("workflow", { required: true });
  const targetRepository = core.getInput("target-repository") || getRequiredEnv("GITHUB_REPOSITORY");
  const sourceRepository = core.getInput("source-repository") || getRequiredEnv("GITHUB_REPOSITORY");

  assertRepository(targetRepository, "target-repository");
  assertRepository(sourceRepository, "source-repository");

  return {
    workflow,
    targetRepository,
    targetRef: core.getInput("target-ref") || defaultBranchFromEvent() || "main",
    token: core.getInput("token"),
    sourceRepository,
    sourceTag: core.getInput("source-tag"),
    sourceSha: core.getInput("source-sha").trim(),
    sourceBaseRef: core.getInput("source-base-ref"),
    requireTag: getBooleanInput("require-tag"),
    tagPattern: core.getInput("tag-pattern"),
    forward: getForwardInput(),
    extraInputs: core.getInput("inputs", { trimWhitespace: false }),
    wait: getBooleanInput("wait"),
    waitTimeoutSeconds: getIntegerInput("wait-timeout-seconds"),
    waitIntervalSeconds: getIntegerInput("wait-interval-seconds"),
    failOnTargetFailure: getBooleanInput("fail-on-target-failure"),
    runNameContains: core.getInput("run-name-contains"),
    dispatchIdInput: core.getInput("dispatch-id-input"),
    summary: getBooleanInput("summary"),
  };
}

async function resolveDispatch(inputs: Inputs): Promise<ResolvedDispatch> {
  const contextTag = tagFromGithubContext();
  const sourceTag = inputs.sourceTag || contextTag;
  const sourceSha = inputs.sourceSha || (inputs.sourceTag ? "" : shaFromGithubContext(contextTag));
  const targetRef = inputs.targetRef || (await defaultRepositoryBranch(inputs.targetRepository, inputs.token, "main"));
  const sourceBaseRef =
    inputs.sourceBaseRef || (await defaultRepositoryBranch(inputs.sourceRepository, inputs.token, ""));
  const dispatchId = crypto.randomUUID();

  if (inputs.requireTag && !sourceTag) {
    throw new Error("source-tag is required. Provide source-tag or run from a tag push event.");
  }

  if (sourceTag && inputs.tagPattern && !matchesGlob(sourceTag, inputs.tagPattern)) {
    throw new Error(`source-tag ${sourceTag} does not match pattern ${inputs.tagPattern}`);
  }

  if (sourceSha) {
    assertSha(sourceSha, "source-sha");
  }

  const fields = parseExtraInputs(inputs.extraInputs);
  setFieldIfValue(fields, "source-tag", sourceTag);
  setFieldIfValue(fields, "source-sha", sourceSha);
  if (inputs.forward === "standard") {
    setFieldIfValue(fields, "source-repository", inputs.sourceRepository);
    setFieldIfValue(fields, "source-base-ref", sourceBaseRef);
  }
  if (inputs.dispatchIdInput) {
    setField(fields, inputs.dispatchIdInput, dispatchId);
  }

  return {
    workflow: inputs.workflow,
    targetRepository: inputs.targetRepository,
    targetRef,
    sourceRepository: inputs.sourceRepository,
    sourceTag,
    sourceSha,
    sourceBaseRef,
    dispatchId,
    fields,
    dispatchedAt: new Date(),
  };
}

async function defaultRepositoryBranch(repository: string, token: string, fallback: string): Promise<string> {
  const eventDefaultBranch = defaultBranchFromEvent();
  if (repository === process.env.GITHUB_REPOSITORY && eventDefaultBranch) {
    return eventDefaultBranch;
  }

  try {
    const result = await githubJson<RepositoryResponse>(token, `/repos/${repository}`, {
      method: "GET",
      expectStatus: [200],
    });
    if (result.default_branch) {
      return result.default_branch;
    }
  } catch (error) {
    core.debug(`Failed to resolve default branch for ${repository}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return fallback;
}

async function createWorkflowDispatch(inputs: Inputs, resolved: ResolvedDispatch): Promise<void> {
  core.info(`Dispatching ${resolved.workflow} on ${resolved.targetRepository}@${resolved.targetRef}`);
  core.info(`Forwarding inputs: ${Object.keys(resolved.fields).join(", ") || "(none)"}`);

  await githubJson<void>(inputs.token, `/repos/${resolved.targetRepository}/actions/workflows/${encodeURIComponent(resolved.workflow)}/dispatches`, {
    method: "POST",
    body: {
      ref: resolved.targetRef,
      inputs: resolved.fields,
    },
    expectStatus: [204],
  });
}

async function waitForWorkflowRun(inputs: Inputs, resolved: ResolvedDispatch): Promise<WorkflowRun> {
  const startedAt = Date.now();
  const timeoutMs = inputs.waitTimeoutSeconds * 1000;
  const intervalMs = inputs.waitIntervalSeconds * 1000;

  for (;;) {
    const run = await findWorkflowRun(inputs, resolved);
    if (run) {
      core.info(`Target workflow run: ${run.html_url}`);
      if (run.status === "completed") {
        return run;
      }
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for target workflow after ${inputs.waitTimeoutSeconds}s`);
    }

    await sleep(intervalMs);
  }
}

async function findWorkflowRun(inputs: Inputs, resolved: ResolvedDispatch): Promise<WorkflowRun | undefined> {
  const query = new URLSearchParams({
    event: "workflow_dispatch",
    branch: resolved.targetRef,
    per_page: "30",
  });
  const response = await githubJson<WorkflowRunsResponse>(
    inputs.token,
    `/repos/${resolved.targetRepository}/actions/workflows/${encodeURIComponent(resolved.workflow)}/runs?${query.toString()}`,
    { method: "GET", expectStatus: [200] },
  );

  const minimumCreatedAt = resolved.dispatchedAt.getTime() - 30_000;
  return (response.workflow_runs ?? [])
    .filter((run) => !run.created_at || Date.parse(run.created_at) >= minimumCreatedAt)
    .filter((run) => !inputs.runNameContains || (run.display_title ?? "").includes(inputs.runNameContains))
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))[0];
}

async function githubJson<T>(
  token: string,
  pathname: string,
  options: { method: string; body?: unknown; expectStatus: number[] },
): Promise<T> {
  if (!token) {
    throw new Error("token is required");
  }

  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  const response = await requestText(`${githubApiBaseUrl()}${pathname}`, {
    method: options.method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      connection: "close",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
      "user-agent": "lwmacct/260707-action-workflow-dispatch",
      "x-github-api-version": "2022-11-28",
    },
    body,
  });

  if (!options.expectStatus.includes(response.statusCode)) {
    throw new Error(`GitHub API request failed: ${response.statusCode} ${response.statusMessage}${response.body ? `\n${response.body}` : ""}`);
  }

  if (response.statusCode === 204) {
    return undefined as T;
  }

  return JSON.parse(response.body) as T;
}

function requestText(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
): Promise<{ statusCode: number; statusMessage: string; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "http:" ? http : https;
    const request = client.request(
      parsedUrl,
      {
        method: options.method,
        headers: options.headers,
        agent: false,
      },
      (response) => {
        response.setEncoding("utf8");
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          response.socket.destroy();
          resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? "",
            body: responseBody,
          });
        });
      },
    );
    request.on("error", reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function parseExtraInputs(value: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`extra input line must use key=value format: ${line}`);
    }

    const name = line.slice(0, separatorIndex).trim();
    const fieldValue = line.slice(separatorIndex + 1);
    setField(fields, name, fieldValue);
  }
  return fields;
}

function setFieldIfValue(fields: Record<string, string>, name: string, value: string): void {
  if (value) {
    setField(fields, name, value);
  }
}

function setField(fields: Record<string, string>, name: string, value: string): void {
  assertInputName(name);
  const current = fields[name];
  if (current !== undefined && current !== value) {
    throw new Error(`workflow input ${name} is defined more than once with different values`);
  }
  fields[name] = value;
}

function setOutputs(resolved: ResolvedDispatch): void {
  core.setOutput("workflow", resolved.workflow);
  core.setOutput("target-repository", resolved.targetRepository);
  core.setOutput("target-ref", resolved.targetRef);
  core.setOutput("source-repository", resolved.sourceRepository);
  core.setOutput("source-tag", resolved.sourceTag);
  core.setOutput("source-sha", resolved.sourceSha);
  core.setOutput("source-base-ref", resolved.sourceBaseRef);
  core.setOutput("dispatch-id", resolved.dispatchId);
  core.setOutput("run-id", resolved.targetRun?.id.toString() ?? "");
  core.setOutput("run-url", resolved.targetRun?.html_url ?? "");
  core.setOutput("status", resolved.targetRun?.status ?? "");
  core.setOutput("conclusion", resolved.targetRun?.conclusion ?? "");
}

async function writeSummary(resolved: ResolvedDispatch): Promise<void> {
  core.summary.addHeading("Workflow dispatched", 2).addTable([
    [
      { data: "Item", header: true },
      { data: "Value", header: true },
    ],
    ["Target repository", code(resolved.targetRepository)],
    ["Target workflow", code(resolved.workflow)],
    ["Target ref", code(resolved.targetRef)],
    ["Source repository", code(resolved.sourceRepository)],
    ["Source tag", code(resolved.sourceTag || "(none)")],
    ["Source SHA", code(resolved.sourceSha || "(none)")],
    ["Source base ref", code(resolved.sourceBaseRef || "(none)")],
    ["Target run", resolved.targetRun ? link(resolved.targetRun.html_url) : code("(not waited)")],
    ["Conclusion", code(resolved.targetRun?.conclusion ?? "(not waited)")],
  ]);

  await core.summary.write();
}

function tagFromGithubContext(): string {
  if (process.env.GITHUB_REF_TYPE === "tag") {
    return process.env.GITHUB_REF_NAME ?? "";
  }

  const ref = process.env.GITHUB_REF ?? "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}

function shaFromGithubContext(tag: string): string {
  return tag ? (process.env.GITHUB_SHA ?? "") : "";
}

function defaultBranchFromEvent(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return "";
  }

  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as GitHubEventPayload;
    const defaultBranch = payload.repository?.default_branch;
    return typeof defaultBranch === "string" ? defaultBranch : "";
  } catch (error) {
    core.debug(`Failed to read default branch from event payload: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function getBooleanInput(name: string): boolean {
  const value = core.getInput(name).toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function getForwardInput(): "minimal" | "standard" {
  const value = core.getInput("forward") || "minimal";
  if (value === "minimal" || value === "standard") {
    return value;
  }
  throw new Error("forward must be minimal or standard");
}

function getIntegerInput(name: string): number {
  const value = core.getInput(name);
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function assertRepository(repository: string, name: string): void {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error(`${name} must use owner/repo format`);
  }
}

function assertInputName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`workflow input name is invalid: ${name}`);
  }
}

function assertSha(value: string, name: string): void {
  if (!/^[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} must be a full 40-character hex commit SHA`);
  }
}

function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegExp(character);
    }
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function githubApiBaseUrl(): string {
  return process.env.GITHUB_API_URL || "https://api.github.com";
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function link(url: string): string {
  return `<a href="${url}">${url}</a>`;
}

await run();
