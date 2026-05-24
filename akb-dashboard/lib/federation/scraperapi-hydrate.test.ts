// INV-022 Sprint 2 — photo hydration pure helper tests.

import { describe, it, expect } from "vitest";
import { summarizePhotoSource, mapPhotosForStore } from "./scraperapi-hydrate";
import type { CollectedPhoto } from "@/lib/photo-sources";

const listing = (url: string): CollectedPhoto => ({ url, source: "listing" });
const street = (url: string): CollectedPhoto => ({ url, source: "streetview" });

describe("summarizePhotoSource", () => {
  it("listing-only → scraperapi", () => {
    expect(summarizePhotoSource([listing("a"), listing("b")])).toBe("scraperapi");
  });
  it("streetview-only → streetview", () => {
    expect(summarizePhotoSource([street("a")])).toBe("streetview");
  });
  it("both → mixed", () => {
    expect(summarizePhotoSource([listing("a"), street("b")])).toBe("mixed");
  });
});

describe("mapPhotosForStore", () => {
  it("maps to {url, source} array preserving order", () => {
    const out = mapPhotosForStore([listing("a"), street("b")]);
    expect(out).toEqual([
      { url: "a", source: "listing" },
      { url: "b", source: "streetview" },
    ]);
  });
  it("empty in → empty out", () => {
    expect(mapPhotosForStore([])).toEqual([]);
  });
});
