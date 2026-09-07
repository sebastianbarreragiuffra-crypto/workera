import assert from "node:assert/strict";
import test from "node:test";
import { GET, dynamic } from "./route";

test("liveness se ejecuta dinámicamente y no expone metadata interna", async () => {
  assert.equal(dynamic, "force-dynamic");
  const response = await GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
