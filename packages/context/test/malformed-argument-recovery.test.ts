import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder, toolTarget } from "../src/index.ts";
for (const argumentsJson of ["null", "[]", "3", '"text"', '{"path":"a.txt","symbol":{"toString":null},"startLine":{"toString":null},"endLine":{"toString":null}}', '{"argv":[{"toString":null}],"patterns":[{"toString":null}]}']) {
 test(`invalid tool arguments ${argumentsJson} remain safe through later compaction`, () => {
  const builder = new ContextBuilder({ system: "sys", tools: [], expandTool: "context_expand" });
  builder.appendUser("fixture");
  for (const [index, name] of ["file_read", "command_run", "file_glob"].entries()) {
   const id = `bad${index}`;
   assert.doesNotThrow(() => toolTarget(name, argumentsJson));
   builder.appendAssistant({ role: "assistant", content: "", reasoning: "", toolCalls: [{ id, name, argumentsJson }] });
   builder.appendToolResult(id, name, "invalid arguments", { kind: "tool_output", target: name, ref: `fixture${index}`, preserve: "error" });
  }
  builder.appendAssistant({ role: "assistant", content: "recovered", reasoning: "", toolCalls: [] });
  assert.doesNotThrow(() => builder.compactionRecord(builder.length));
 });
}
