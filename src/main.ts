import * as core from "@actions/core";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Inputs {
  workflow: string;
  ref: string;
  repository: string;
  githubToken: string;
  tag: string;
  sha: string;
  requireTag: boolean;
  tagPattern: string;
  tagInput: string;
  shaInput: string;
  extraInputs: string;
  summary: boolean;
}

interface ResolvedContext {
  workflow: string;
  ref: string;
  repository: string;
  tag: string;
  sha: string;
  fields: Map<string, string>;
}

interface GitHubEventPayload {
  repository?: {
    default_branch?: unknown;
  };
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const resolved = resolveContext(inputs);
    await dispatchWorkflow(inputs, resolved);
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
  const repository = core.getInput("repository") || getRequiredEnv("GITHUB_REPOSITORY");
  assertRepository(repository);

  return {
    workflow,
    ref: core.getInput("ref"),
    repository,
    githubToken: core.getInput("github-token"),
    tag: core.getInput("tag"),
    sha: core.getInput("sha"),
    requireTag: getBooleanInput("require-tag"),
    tagPattern: core.getInput("tag-pattern"),
    tagInput: core.getInput("tag-input"),
    shaInput: core.getInput("sha-input"),
    extraInputs: core.getInput("inputs", { trimWhitespace: false }),
    summary: getBooleanInput("summary"),
  };
}

function resolveContext(inputs: Inputs): ResolvedContext {
  const contextTag = tagFromGithubContext();
  const tag = inputs.tag || contextTag;
  const sha = inputs.sha || (inputs.tag ? "" : shaFromGithubContext(contextTag));
  const ref = inputs.ref || defaultBranchFromEvent() || "main";

  if (inputs.requireTag && !tag) {
    throw new Error("tag is required. Provide the tag input or run from a tag push event.");
  }

  if (tag && inputs.tagPattern && !matchesGlob(tag, inputs.tagPattern)) {
    throw new Error(`tag ${tag} does not match pattern ${inputs.tagPattern}`);
  }

  const fields = parseExtraInputs(inputs.extraInputs);
  if (inputs.tagInput && tag) {
    setField(fields, inputs.tagInput, tag);
  }
  if (inputs.shaInput && (sha || tag)) {
    setField(fields, inputs.shaInput, sha);
  }

  return {
    workflow: inputs.workflow,
    ref,
    repository: inputs.repository,
    tag,
    sha,
    fields,
  };
}

async function dispatchWorkflow(inputs: Inputs, resolved: ResolvedContext): Promise<void> {
  const args = ["workflow", "run", resolved.workflow, "--repo", resolved.repository, "--ref", resolved.ref];
  for (const [name, value] of resolved.fields) {
    args.push("-f", `${name}=${value}`);
  }

  core.info(`Dispatching ${resolved.workflow} on ${resolved.repository}@${resolved.ref}`);
  if (resolved.fields.size > 0) {
    core.info(`Forwarding inputs: ${[...resolved.fields.keys()].join(", ")}`);
  }

  const env = { ...process.env };
  if (inputs.githubToken) {
    env.GH_TOKEN = inputs.githubToken;
  }

  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      env,
      maxBuffer: 1024 * 1024,
    });
    if (stdout.trim()) {
      core.info(stdout.trim());
    }
    if (stderr.trim()) {
      core.info(stderr.trim());
    }
  } catch (error) {
    if (isExecError(error)) {
      const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
      throw new Error(output || error.message);
    }
    throw error;
  }
}

function setOutputs(resolved: ResolvedContext): void {
  core.setOutput("workflow", resolved.workflow);
  core.setOutput("ref", resolved.ref);
  core.setOutput("repository", resolved.repository);
  core.setOutput("tag", resolved.tag);
  core.setOutput("sha", resolved.sha);
}

async function writeSummary(resolved: ResolvedContext): Promise<void> {
  core.summary
    .addHeading("Workflow dispatched", 2)
    .addTable([
      [
        { data: "Item", header: true },
        { data: "Value", header: true },
      ],
      ["Repository", code(resolved.repository)],
      ["Workflow", code(resolved.workflow)],
      ["Workflow ref", code(resolved.ref)],
      ["Tag", code(resolved.tag || "(none)")],
      ["SHA", code(resolved.sha || "(none)")],
    ]);

  if (resolved.fields.size > 0) {
    core.summary.addHeading("Forwarded inputs", 3).addTable([
      [
        { data: "Name", header: true },
        { data: "Value", header: true },
      ],
      ...[...resolved.fields].map(([name, value]) => [code(name), code(value)]),
    ]);
  }

  await core.summary.write();
}

function parseExtraInputs(value: string): Map<string, string> {
  const fields = new Map<string, string>();
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

function setField(fields: Map<string, string>, name: string, value: string): void {
  assertInputName(name);
  const current = fields.get(name);
  if (current !== undefined && current !== value) {
    throw new Error(`workflow input ${name} is defined more than once with different values`);
  }
  fields.set(name, value);
}

function tagFromGithubContext(): string {
  if (process.env.GITHUB_REF_TYPE === "tag") {
    return process.env.GITHUB_REF_NAME ?? "";
  }

  const ref = process.env.GITHUB_REF ?? "";
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}

function shaFromGithubContext(tag: string): string {
  if (!tag) {
    return "";
  }
  return process.env.GITHUB_SHA ?? "";
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

function assertRepository(repository: string): void {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) {
    throw new Error("repository must use owner/repo format");
  }
}

function assertInputName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`workflow input name is invalid: ${name}`);
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

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function isExecError(error: unknown): error is Error & { stdout?: string; stderr?: string } {
  return error instanceof Error;
}

await run();
