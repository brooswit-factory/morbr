import test from "node:test";
import assert from "node:assert/strict";
import { createMorbr } from "../src/index.js";

test("creates the Morbr client marker", () => {
  assert.deepEqual(createMorbr(), { client: "morbr" });
});
