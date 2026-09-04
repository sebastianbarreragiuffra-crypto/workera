import assert from "node:assert/strict";
import test from "node:test";
import manifest from "@/app/manifest";

test("manifest instala GESTORA como PWA standalone sin inventar una app nativa", () => {
  const value = manifest();
  assert.equal(value.display, "standalone");
  assert.equal(value.start_url, "/");
  assert.equal(value.scope, "/");
  assert.equal(value.theme_color, "#142a4c");
  assert.equal(value.icons?.some((icon) => icon.sizes === "192x192"), true);
  assert.equal(value.icons?.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"), true);
});
