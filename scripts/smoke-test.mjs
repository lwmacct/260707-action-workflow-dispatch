import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";

const actionPath = path.resolve("dist/index.js");

async function main() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });

      if (request.method === "POST" && request.url === "/repos/owner/target/actions/workflows/publish.yml/dispatches") {
        response.writeHead(204, { connection: "close" }).end();
        return;
      }

      response.writeHead(404, { connection: "close" }).end("not found");
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const port = server.address().port;
    await runAction(port);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }

  const request = requests.find((item) => item.method === "POST");
  assert(request, "missing dispatch request");
  assert(request.headers["user-agent"] === "lwmacct/260707-action-workflow-dispatch", "user-agent mismatch");

  const payload = JSON.parse(request.body);
  assert(payload.ref === "main", "target ref mismatch");
  assert(payload.inputs["source-tag"] === "v1.2.3", "source-tag mismatch");
  assert(payload.inputs["source-sha"] === "0123456789012345678901234567890123456789", "source-sha mismatch");
  assert(payload.inputs.environment === "test", "extra input mismatch");
  assert(!("source-repository" in payload.inputs), "source-repository should not be forwarded");
  assert(!("source-base-ref" in payload.inputs), "source-base-ref should not be forwarded");

  console.log("smoke-test ok");
}

function runAction(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [actionPath], {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: "owner/source",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: "0123456789012345678901234567890123456789",
        INPUT_WORKFLOW: "publish.yml",
        "INPUT_TARGET-REPOSITORY": "owner/target",
        "INPUT_TARGET-REF": "main",
        INPUT_TOKEN: "test-token",
        INPUT_INPUTS: "environment=test",
        INPUT_WAIT: "false",
        INPUT_SUMMARY: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("action timed out"));
    }, 10_000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`action failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
