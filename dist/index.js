import { s as setFailed, g as getInput, i as info, a as setOutput, b as summary, d as debug } from './chunks/actions-shared.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);
async function run() {
    try {
        const inputs = getInputs();
        const resolved = resolveContext(inputs);
        await dispatchWorkflow(inputs, resolved);
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
    const repository = getInput("repository") || getRequiredEnv("GITHUB_REPOSITORY");
    assertRepository(repository);
    return {
        workflow,
        ref: getInput("ref"),
        repository,
        githubToken: getInput("github-token"),
        tag: getInput("tag"),
        sha: getInput("sha"),
        requireTag: getBooleanInput("require-tag"),
        tagPattern: getInput("tag-pattern"),
        tagInput: getInput("tag-input"),
        shaInput: getInput("sha-input"),
        extraInputs: getInput("inputs", { trimWhitespace: false }),
        summary: getBooleanInput("summary"),
    };
}
function resolveContext(inputs) {
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
async function dispatchWorkflow(inputs, resolved) {
    const args = ["workflow", "run", resolved.workflow, "--repo", resolved.repository, "--ref", resolved.ref];
    for (const [name, value] of resolved.fields) {
        args.push("-f", `${name}=${value}`);
    }
    info(`Dispatching ${resolved.workflow} on ${resolved.repository}@${resolved.ref}`);
    if (resolved.fields.size > 0) {
        info(`Forwarding inputs: ${[...resolved.fields.keys()].join(", ")}`);
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
            info(stdout.trim());
        }
        if (stderr.trim()) {
            info(stderr.trim());
        }
    }
    catch (error) {
        if (isExecError(error)) {
            const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
            throw new Error(output || error.message);
        }
        throw error;
    }
}
function setOutputs(resolved) {
    setOutput("workflow", resolved.workflow);
    setOutput("ref", resolved.ref);
    setOutput("repository", resolved.repository);
    setOutput("tag", resolved.tag);
    setOutput("sha", resolved.sha);
}
async function writeSummary(resolved) {
    summary
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
        summary.addHeading("Forwarded inputs", 3).addTable([
            [
                { data: "Name", header: true },
                { data: "Value", header: true },
            ],
            ...[...resolved.fields].map(([name, value]) => [code(name), code(value)]),
        ]);
    }
    await summary.write();
}
function parseExtraInputs(value) {
    const fields = new Map();
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
function setField(fields, name, value) {
    assertInputName(name);
    const current = fields.get(name);
    if (current !== undefined && current !== value) {
        throw new Error(`workflow input ${name} is defined more than once with different values`);
    }
    fields.set(name, value);
}
function tagFromGithubContext() {
    if (process.env.GITHUB_REF_TYPE === "tag") {
        return process.env.GITHUB_REF_NAME ?? "";
    }
    const ref = process.env.GITHUB_REF ?? "";
    return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : "";
}
function shaFromGithubContext(tag) {
    if (!tag) {
        return "";
    }
    return process.env.GITHUB_SHA ?? "";
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
function assertRepository(repository) {
    const [owner, repo, extra] = repository.split("/");
    if (!owner || !repo || extra) {
        throw new Error("repository must use owner/repo format");
    }
}
function assertInputName(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`workflow input name is invalid: ${name}`);
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
function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}
function code(value) {
    return `\`${value.replaceAll("`", "\\`")}\``;
}
function isExecError(error) {
    return error instanceof Error;
}
await run();
