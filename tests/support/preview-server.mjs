import { buildApp } from "../../apps/server/dist/app.js";
import { registerWebStatic } from "../../apps/server/dist/web-static.js";
import {
  defaultAppearance,
  registerAppearance,
} from "../../apps/server/dist/appearance.js";

// Browser-test process only. Production always uses PostgreSQL through main.js.
let appearance = { ...defaultAppearance };
const store = {
  get: async () => appearance,
  patch: async (value) => {
    appearance = { ...appearance, ...value };
    return appearance;
  },
};
const app = buildApp();
app.get("/api/auth/status", async () => ({
  ownerExists: true,
  authenticated: true,
  recoveryAuthenticated: false,
  recoveryMode: null,
  pendingTotpUri: null,
  csrfToken: "fixture-token",
}));
registerAppearance(app, store);
await registerWebStatic(app, 'http://127.0.0.1:4173');
await app.listen({ host: "127.0.0.1", port: 4173 });
