import { s as setFailed, g as getInput, i as info, a as setOutput, b as summary, d as debug } from './chunks/actions-shared.js';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import 'path';
import 'os';
import 'crypto';
import 'fs';
import 'http';
import 'https';
import './chunks/vendor.js';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'node:assert';
import 'node:net';
import 'node:http';
import 'node:stream';
import 'node:buffer';
import 'node:util';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'string_decoder';
import 'child_process';
import 'timers';

async function run() {
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
    }
    catch (error) {
        setFailed(error instanceof Error ? error.message : "Unexpected failure");
    }
}
function getInputs() {
    const workflow = getInput("workflow", { required: true });
    const targetRepository = getInput("target-repository") || getRequiredEnv("GITHUB_REPOSITORY");
    const sourceRepository = getInput("source-repository") || getRequiredEnv("GITHUB_REPOSITORY");
    assertRepository(targetRepository, "target-repository");
    assertRepository(sourceRepository, "source-repository");
    return {
        workflow,
        targetRepository,
        targetRef: getInput("target-ref") || defaultBranchFromEvent() || "main",
        token: getInput("token"),
        sourceRepository,
        sourceTag: getInput("source-tag"),
        sourceSha: getInput("source-sha").trim(),
        sourceBaseRef: getInput("source-base-ref"),
        requireTag: getBooleanInput("require-tag"),
        tagPattern: getInput("tag-pattern"),
        extraInputs: getInput("inputs", { trimWhitespace: false }),
        wait: getBooleanInput("wait"),
        waitTimeoutSeconds: getIntegerInput("wait-timeout-seconds"),
        waitIntervalSeconds: getIntegerInput("wait-interval-seconds"),
        failOnTargetFailure: getBooleanInput("fail-on-target-failure"),
        runNameContains: getInput("run-name-contains"),
        dispatchIdInput: getInput("dispatch-id-input"),
        summary: getBooleanInput("summary"),
    };
}
async function resolveDispatch(inputs) {
    const contextTag = tagFromGithubContext();
    const sourceTag = inputs.sourceTag || contextTag;
    const sourceSha = inputs.sourceSha || (inputs.sourceTag ? "" : shaFromGithubContext(contextTag));
    const targetRef = inputs.targetRef || (await defaultRepositoryBranch(inputs.targetRepository, inputs.token, "main"));
    const sourceBaseRef = inputs.sourceBaseRef || (await defaultRepositoryBranch(inputs.sourceRepository, inputs.token, ""));
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
    setFieldIfValue(fields, "source-repository", inputs.sourceRepository);
    setFieldIfValue(fields, "source-tag", sourceTag);
    setFieldIfValue(fields, "source-sha", sourceSha);
    setFieldIfValue(fields, "source-base-ref", sourceBaseRef);
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
async function defaultRepositoryBranch(repository, token, fallback) {
    const eventDefaultBranch = defaultBranchFromEvent();
    if (repository === process.env.GITHUB_REPOSITORY && eventDefaultBranch) {
        return eventDefaultBranch;
    }
    try {
        const result = await githubJson(token, `/repos/${repository}`, {
            method: "GET",
            expectStatus: [200],
        });
        if (result.default_branch) {
            return result.default_branch;
        }
    }
    catch (error) {
        debug(`Failed to resolve default branch for ${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return fallback;
}
async function createWorkflowDispatch(inputs, resolved) {
    info(`Dispatching ${resolved.workflow} on ${resolved.targetRepository}@${resolved.targetRef}`);
    info(`Forwarding inputs: ${Object.keys(resolved.fields).join(", ") || "(none)"}`);
    await githubJson(inputs.token, `/repos/${resolved.targetRepository}/actions/workflows/${encodeURIComponent(resolved.workflow)}/dispatches`, {
        method: "POST",
        body: {
            ref: resolved.targetRef,
            inputs: resolved.fields,
        },
        expectStatus: [204],
    });
}
async function waitForWorkflowRun(inputs, resolved) {
    const startedAt = Date.now();
    const timeoutMs = inputs.waitTimeoutSeconds * 1000;
    const intervalMs = inputs.waitIntervalSeconds * 1000;
    for (;;) {
        const run = await findWorkflowRun(inputs, resolved);
        if (run) {
            info(`Target workflow run: ${run.html_url}`);
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
async function findWorkflowRun(inputs, resolved) {
    const query = new URLSearchParams({
        event: "workflow_dispatch",
        branch: resolved.targetRef,
        per_page: "30",
    });
    const response = await githubJson(inputs.token, `/repos/${resolved.targetRepository}/actions/workflows/${encodeURIComponent(resolved.workflow)}/runs?${query.toString()}`, { method: "GET", expectStatus: [200] });
    const minimumCreatedAt = resolved.dispatchedAt.getTime() - 30_000;
    return (response.workflow_runs ?? [])
        .filter((run) => !run.created_at || Date.parse(run.created_at) >= minimumCreatedAt)
        .filter((run) => !inputs.runNameContains || (run.display_title ?? "").includes(inputs.runNameContains))
        .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))[0];
}
async function githubJson(token, pathname, options) {
    if (!token) {
        throw new Error("token is required");
    }
    const requestInit = {
        method: options.method,
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
        },
    };
    if (options.body !== undefined) {
        requestInit.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${githubApiBaseUrl()}${pathname}`, requestInit);
    if (!options.expectStatus.includes(response.status)) {
        const body = await response.text();
        throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`);
    }
    if (response.status === 204) {
        return undefined;
    }
    return (await response.json());
}
function parseExtraInputs(value) {
    const fields = {};
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
function setFieldIfValue(fields, name, value) {
    if (value) {
        setField(fields, name, value);
    }
}
function setField(fields, name, value) {
    assertInputName(name);
    const current = fields[name];
    if (current !== undefined && current !== value) {
        throw new Error(`workflow input ${name} is defined more than once with different values`);
    }
    fields[name] = value;
}
function setOutputs(resolved) {
    setOutput("workflow", resolved.workflow);
    setOutput("target-repository", resolved.targetRepository);
    setOutput("target-ref", resolved.targetRef);
    setOutput("source-repository", resolved.sourceRepository);
    setOutput("source-tag", resolved.sourceTag);
    setOutput("source-sha", resolved.sourceSha);
    setOutput("source-base-ref", resolved.sourceBaseRef);
    setOutput("dispatch-id", resolved.dispatchId);
    setOutput("run-id", resolved.targetRun?.id.toString() ?? "");
    setOutput("run-url", resolved.targetRun?.html_url ?? "");
    setOutput("status", resolved.targetRun?.status ?? "");
    setOutput("conclusion", resolved.targetRun?.conclusion ?? "");
}
async function writeSummary(resolved) {
    summary.addHeading("Workflow dispatched", 2).addTable([
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
    await summary.write();
}
function tagFromGithubContext() {
    if (process.env.GITHUB_REF_TYPE === "tag") {
        return process.env.GITHUB_REF_NAME ?? "";
    }
    const ref = process.env.GITHUB_REF ?? "";
    return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}
function shaFromGithubContext(tag) {
    return tag ? (process.env.GITHUB_SHA ?? "") : "";
}
function defaultBranchFromEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        return "";
    }
    try {
        const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        const defaultBranch = payload.repository?.default_branch;
        return typeof defaultBranch === "string" ? defaultBranch : "";
    }
    catch (error) {
        debug(`Failed to read default branch from event payload: ${error instanceof Error ? error.message : String(error)}`);
        return "";
    }
}
function getBooleanInput(name) {
    const value = getInput(name).toLowerCase();
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
function getIntegerInput(name) {
    const value = getInput(name);
    if (!value) {
        return 0;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
}
function assertRepository(repository, name) {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra) {
        throw new Error(`${name} must use owner/repo format`);
    }
}
function assertInputName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`workflow input name is invalid: ${name}`);
    }
}
function assertSha(value, name) {
    if (!/^[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`${name} must be a full 40-character hex commit SHA`);
    }
}
function matchesGlob(value, pattern) {
    return globToRegExp(pattern).test(value);
}
function globToRegExp(pattern) {
    let source = "^";
    for (const character of pattern) {
        if (character === "*") {
            source += ".*";
        }
        else if (character === "?") {
            source += ".";
        }
        else {
            source += escapeRegExp(character);
        }
    }
    source += "$";
    return new RegExp(source);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function githubApiBaseUrl() {
    return process.env.GITHUB_API_URL || "https://api.github.com";
}
function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function code(value) {
    return `\`${value.replaceAll("`", "\\`")}\``;
}
function link(url) {
    return `<a href="${url}">${url}</a>`;
}
await run();
