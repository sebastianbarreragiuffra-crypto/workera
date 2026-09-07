import { test } from "node:test";
import assert from "node:assert/strict";
import { requireSecureWorkeraBaseUrl } from "./config";
import { WorkeraConfigurationError } from "./errors";

test("requireSecureWorkeraBaseUrl: acepta y normaliza sólo una base HTTPS", () => {
  assert.equal(
    requireSecureWorkeraBaseUrl("https://workera.example.test/apiClient/v1/"),
    "https://workera.example.test/apiClient/v1",
  );
});

for (const { label, value } of [
  { label: "HTTP", value: "http://workera.example.test/apiClient/v1" },
  { label: "formato inválido", value: "no-es-una-url" },
  { label: "credenciales embebidas", value: "https://usuario:secreto@workera.example.test/apiClient/v1" },
  { label: "query", value: "https://workera.example.test/apiClient/v1?destino=otro" },
  { label: "fragmento", value: "https://workera.example.test/apiClient/v1#fragmento" },
]) {
  test(`requireSecureWorkeraBaseUrl: rechaza ${label}`, () => {
    assert.throws(() => requireSecureWorkeraBaseUrl(value), WorkeraConfigurationError);
  });
}
