import assert from "node:assert/strict";
import { IPC } from "@xhayper/discord-rpc";
import { test } from "node:test";

test("discord IPC transport exposes the framed protocol opcodes", () => {
  assert.equal(IPC.IPC_OPCODE.HANDSHAKE, 0);
  assert.equal(IPC.IPC_OPCODE.FRAME, 1);
  assert.equal(IPC.IPC_OPCODE.CLOSE, 2);
});

test("discord IPC resolves the Windows named pipe path", () => {
  const transport = new IPC.IPCTransport({ client: { clientId: "123456789012345678" } });
  assert.match(String(transport.pathList[0].format(0)), /discord-ipc-0/);
});
