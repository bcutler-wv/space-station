import { expect, test } from "vitest";
import sharp from "sharp";
import { buildApp } from "./app.js";
import {
  defaultAppearance,
  type AppearanceStore,
  type StoredAppearance,
} from "./appearance.js";

function memoryStore(): AppearanceStore {
  let value: StoredAppearance = { ...defaultAppearance };
  return {
    get: async () => value,
    patch: async (patch) => {
      value = { ...value, ...patch };
      return value;
    },
  };
}

test("appearance settings validate and preserve uploaded wallpaper across mode changes", async () => {
  const app = buildApp(undefined, memoryStore());
  try {
    const image = await sharp({
      create: {
        width: 80,
        height: 80,
        channels: 3,
        background: { r: 25, g: 140, b: 200 },
      },
    })
      .png()
      .toBuffer();
    const upload = await app.inject({
      method: "POST",
      url: "/api/appearance/wallpaper",
      headers: { "content-type": "image/png" },
      payload: image,
    });
    expect(upload.statusCode, upload.body).toBe(200);
    expect(upload.json().hasWallpaper).toBe(true);
    const update = await app.inject({
      method: "PUT",
      url: "/api/appearance",
      payload: { mode: "dark", showWallpaper: false },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      mode: "dark",
      showWallpaper: false,
      hasWallpaper: true,
    });
    const wallpaper = await app.inject({
      method: "GET",
      url: "/api/appearance/wallpaper",
    });
    expect(wallpaper.statusCode).toBe(200);
    expect(wallpaper.headers["content-type"]).toContain("image/webp");
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/appearance",
      payload: { mode: "sepia", showWallpaper: true },
    });
    expect(invalid.statusCode).toBe(400);
    const reset = await app.inject({
      method: "DELETE",
      url: "/api/appearance/wallpaper",
    });
    expect(reset.json()).toMatchObject({ mode: "dark", hasWallpaper: false });
    expect(
      (await app.inject({ method: "GET", url: "/api/appearance/wallpaper" }))
        .statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test("rejects SVG and oversized raster input", async () => {
  const app = buildApp(undefined, memoryStore());
  try {
    const svg = await app.inject({
      method: "POST",
      url: "/api/appearance/wallpaper",
      headers: { "content-type": "image/svg+xml" },
      payload: "<svg></svg>",
    });
    expect(svg.statusCode).toBe(415);
    const large = await sharp({
      create: {
        width: 4000,
        height: 4000,
        channels: 3,
        background: { r: 5, g: 8, b: 9 },
      },
    })
      .png()
      .toBuffer();
    const response = await app.inject({
      method: "POST",
      url: "/api/appearance/wallpaper",
      headers: { "content-type": "image/png" },
      payload: large,
    });
    expect(response.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test("storage failures are server errors, not invalid image errors", async () => {
  const store = memoryStore();
  store.patch = async () => {
    throw new Error("store unavailable");
  };
  const app = buildApp(undefined, store);
  try {
    const image = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 10, g: 40, b: 90 },
      },
    })
      .png()
      .toBuffer();
    const response = await app.inject({
      method: "POST",
      url: "/api/appearance/wallpaper",
      headers: { "content-type": "image/png" },
      payload: image,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("store unavailable");
  } finally {
    await app.close();
  }
});
