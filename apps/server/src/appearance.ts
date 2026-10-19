import type { FastifyInstance } from "fastify";
import {
  appearanceResponseSchema,
  appearanceUpdateSchema,
  type AppearanceResponse,
} from "@station/shared";
import { DEFAULT_SEED, seedFromPixels } from "@station/theme";
import sharp from "sharp";

export interface StoredAppearance extends AppearanceResponse {
  wallpaper: string | null;
}
export interface AppearanceStore {
  get(): Promise<StoredAppearance>;
  patch(value: Partial<StoredAppearance>): Promise<StoredAppearance>;
}
export const defaultAppearance: StoredAppearance = {
  mode: "system",
  showWallpaper: true,
  seed: DEFAULT_SEED,
  hasWallpaper: false,
  wallpaper: null,
};
const publicAppearance = (value: StoredAppearance): AppearanceResponse =>
  appearanceResponseSchema.parse({
    mode: value.mode,
    showWallpaper: value.showWallpaper,
    seed: value.seed,
    hasWallpaper: value.hasWallpaper,
  });
const imageTypes = ["image/png", "image/jpeg", "image/webp"];

export function registerAppearance(
  app: FastifyInstance,
  store: AppearanceStore,
): void {
  for (const contentType of imageTypes) {
    app.addContentTypeParser(
      contentType,
      { parseAs: "buffer", bodyLimit: 4_000_000 },
      (_request, body, done) => done(null, body),
    );
  }
  app.get("/api/appearance", async () => publicAppearance(await store.get()));
  app.put("/api/appearance", async (request, reply) => {
    const parsed = appearanceUpdateSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Choose a valid theme and wallpaper visibility." });
    const next = await store.patch(parsed.data);
    return publicAppearance(next);
  });
  app.get("/api/appearance/wallpaper", async (_request, reply) => {
    const current = await store.get();
    if (!current.wallpaper)
      return reply.code(404).send({ error: "No wallpaper has been uploaded." });
    return reply
      .header("Cache-Control", "private, no-store")
      .type("image/webp")
      .send(Buffer.from(current.wallpaper, "base64"));
  });
  app.post(
    "/api/appearance/wallpaper",
    { bodyLimit: 4_000_000 },
    async (request, reply) => {
      if (
        !imageTypes.includes(request.headers["content-type"] ?? "") ||
        !Buffer.isBuffer(request.body)
      ) {
        return reply
          .code(415)
          .send({ error: "Upload a PNG, JPEG, or WebP image." });
      }
      let normalized: Buffer;
      let seed: number;
      try {
        const image = sharp(request.body, {
          limitInputPixels: 12_000_000,
          failOn: "error",
        });
        const metadata = await image.metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          metadata.width * metadata.height > 12_000_000 ||
          !["png", "jpeg", "webp"].includes(metadata.format)
        ) {
          return reply
            .code(400)
            .send({
              error: "Choose a valid image with at most 12 million pixels.",
            });
        }
        normalized = await image
          .rotate()
          .resize(1200, 800, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 })
          .toBuffer();
        if (normalized.length > 750_000)
          return reply
            .code(413)
            .send({
              error:
                "Choose a smaller image. The processed wallpaper exceeds 750 KB.",
            });
        const { data, info } = await sharp(normalized)
          .resize(64, 64, { fit: "inside" })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (info.channels !== 4) throw new Error("Unexpected pixel format");
        seed = seedFromPixels(new Uint8ClampedArray(data));
      } catch {
        return reply
          .code(400)
          .send({
            error:
              "The image could not be processed. Choose a PNG, JPEG, or WebP under 4 MB.",
          });
      }
      const next = await store.patch({
        seed,
        hasWallpaper: true,
        wallpaper: normalized.toString("base64"),
      });
      return publicAppearance(next);
    },
  );
  app.delete("/api/appearance/wallpaper", async () => {
    const next = await store.patch({
      seed: DEFAULT_SEED,
      hasWallpaper: false,
      wallpaper: null,
    });
    return publicAppearance(next);
  });
}
