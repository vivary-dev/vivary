import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode === "exit-only") {
  process.exit(0);
} else if (mode === "failed-loopback-fetch") {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "/" });
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await assert.rejects(fetch(`http://127.0.0.1:${server.address().port}/`, {
    signal: AbortSignal.timeout(3000),
  }));
  process.exit(0);
} else {
  for (const childMode of ["exit-only", "failed-loopback-fetch"]) {
    test(`runtime exits normally after ${childMode}`, () => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), childMode], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 6000,
          env: process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot || "C:\\Windows" }
            : {},
        });
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
      }
    });
  }
}
