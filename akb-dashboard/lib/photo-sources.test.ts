// @agent: appraiser — Firecrawl photo-set filter tests.
//
// The rehab-vision pipeline pulls every `.jpg` URL on a Redfin listing
// page that matches the Redfin CDN regex; without filtering, that set
// includes (a) chrome / icons / static UI assets, (b) agent headshots
// and brand logos, (c) recommended listings + nearby-comp carousels.
// All three categories contaminate the photo set passed to Anthropic
// vision, driving low confidence + nonsense estimates.
//
// filterPropertyPhotos must drop only those three categories — keep
// every genuine subject photo, interior AND exterior. Exterior shots
// (roof / siding / foundation) are critical rehab signal.

import { describe, it, expect } from "vitest";
import {
  filterPropertyPhotos,
  extractRedfinListingId,
  photoIdentityKey,
  zillowResolutionRank,
  FIRECRAWL_PHOTO_DENY_PATTERNS,
  FIRECRAWL_HTML_IMG_RE,
  publishablePhotos,
  type CollectedPhoto,
} from "./photo-sources";

const SUBJECT_PAGE = "https://www.redfin.com/TX/Dallas/924-Sunnyside-Ave-75211/home/32118136";

// Realistic Redfin CDN photo URL shape — listing id 32118136 is the
// subject. The path puts the listing id and a photo index before .jpg.
// Resolution tags Redfin actually uses: bigphoto, mbphoto, islnoresize.
const RES_PATH: Record<"big" | "mb" | "isl", string> = {
  big: "bigphoto",
  mb: "mbphoto",
  isl: "islnoresize",
};
const subjectPhoto = (idx: number, res: "big" | "mb" | "isl" = "big") =>
  `https://ssl.cdn-redfin.com/photo/72/${RES_PATH[res]}/136/32118136_${idx}.jpg`;

const compPhoto = (listingId: string, idx: number) =>
  `https://ssl.cdn-redfin.com/photo/72/bigphoto/136/${listingId}_${idx}.jpg`;

describe("extractRedfinListingId", () => {
  it("pulls id from a listing-page URL", () => {
    expect(extractRedfinListingId(SUBJECT_PAGE)).toBe("32118136");
  });

  it("pulls id from a Redfin CDN photo URL", () => {
    expect(extractRedfinListingId(subjectPhoto(0))).toBe("32118136");
  });

  it("pulls id from photo URL without intermediate filename segment", () => {
    expect(
      extractRedfinListingId("https://ssl.cdn-redfin.com/photo/72/bigphoto/136/12345678_3.jpg"),
    ).toBe("12345678");
  });

  it("returns null when no id is present", () => {
    expect(extractRedfinListingId("https://ssl.cdn-redfin.com/static/logo.jpg")).toBeNull();
    expect(extractRedfinListingId("")).toBeNull();
  });

  it("ignores short numeric runs (must be ≥ 4 digits)", () => {
    expect(extractRedfinListingId("https://example.com/home/12")).toBeNull();
  });
});

describe("filterPropertyPhotos — chrome / UI assets", () => {
  it("drops obvious chrome by pattern", () => {
    const urls = [
      "https://ssl.cdn-redfin.com/static/sprite.jpg",
      "https://ssl.cdn-redfin.com/assets/icons/heart.jpg",
      "https://ssl.cdn-redfin.com/agentphoto/123/headshot.jpg",
      "https://ssl.cdn-redfin.com/static/brokerage-logo.jpg",
      "https://ssl.cdn-redfin.com/mediacdn/placeholder.jpg",
      subjectPhoto(0),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.dropped_chrome).toBeGreaterThanOrEqual(5);
    expect(out.kept).toEqual([subjectPhoto(0)]);
  });

  it("does NOT drop genuine exterior photos (regression: roof/siding signal)", () => {
    // Realistic exterior photos all live under /photo/.../bigphoto/...
    // — no chrome pattern matches.
    const urls = [
      subjectPhoto(0), // exterior front
      subjectPhoto(1), // exterior side
      subjectPhoto(7), // backyard / roof from rear
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.kept).toEqual(urls);
    expect(out.dropped_chrome).toBe(0);
  });

  it("FIRECRAWL_PHOTO_DENY_PATTERNS covers all expected categories", () => {
    // Sanity: the denylist exports as a frozen-ish constant so the
    // operator can inspect it without spelunking. Just guard that the
    // critical buckets are represented.
    const patterns = FIRECRAWL_PHOTO_DENY_PATTERNS.join("|");
    expect(patterns).toContain("agent");
    expect(patterns).toContain("logo");
    expect(patterns).toContain("staticmap");
    expect(patterns).toContain("placeholder");
  });
});

describe("filterPropertyPhotos — comp / cluster filtering (FAIL OPEN)", () => {
  it("drops comps only when the subject cluster is confidently the largest", () => {
    const urls = [
      subjectPhoto(0),
      subjectPhoto(1),
      subjectPhoto(2),
      compPhoto("99999999", 0),
      compPhoto("99999999", 1),
      compPhoto("88888888", 0),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.subject_listing_id).toBe("32118136");
    // Subject cluster (3) is largest → comps (99999999 x2, 88888888 x1)
    // dropped.
    expect(out.kept).toEqual([subjectPhoto(0), subjectPhoto(1), subjectPhoto(2)]);
    expect(out.dropped_offcluster).toBe(3);
  });

  it("FAIL OPEN: keeps everything non-chrome when subject cluster is NOT the largest", () => {
    // Regression for the 924 Sunnyside 69→1 collapse: a comp cluster
    // is bigger than the (mis-parsed) subject cluster. We must NOT drop
    // the subject's photos — keep all non-chrome.
    const urls = [
      subjectPhoto(0), // only 1 subject photo parsed to the subject id
      compPhoto("99999999", 0),
      compPhoto("99999999", 1),
      compPhoto("99999999", 2),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.kept.length).toBe(4); // nothing dropped as off-cluster
    expect(out.dropped_offcluster).toBe(0);
  });

  it("FAIL OPEN: keeps unclustered (noId) photos alongside the subject cluster", () => {
    // The real 924 Sunnyside failure mode: most subject photos are in a
    // CDN format our id regex can't parse (noId), with the subject id
    // appearing on only a couple. noId photos are almost always subject
    // photos — they must be KEPT, not dropped.
    const noIdPhoto = (n: number) =>
      `https://ssl.cdn-redfin.com/photo/72/bigphoto/genMidShot.${n}.jpg`;
    const urls = [
      subjectPhoto(0),
      subjectPhoto(1),
      subjectPhoto(2),
      noIdPhoto(1),
      noIdPhoto(2),
      compPhoto("99999999", 0),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    // Subject cluster (3) is largest id-cluster → confident drop of the
    // comp, but noId photos are KEPT (joined to subject).
    expect(out.kept).toContain(noIdPhoto(1));
    expect(out.kept).toContain(noIdPhoto(2));
    expect(out.kept).not.toContain(compPhoto("99999999", 0));
  });

  it("FAIL OPEN: no source id → keep everything non-chrome (no largest-cluster guess)", () => {
    const urls = [
      compPhoto("11111111", 0),
      compPhoto("22222222", 0),
      compPhoto("22222222", 1),
      compPhoto("33333333", 0),
    ];
    const out = filterPropertyPhotos(urls, null);
    expect(out.kept.length).toBe(4);
    expect(out.dropped_offcluster).toBe(0);
  });

  it("reports cluster sizes for operator audit", () => {
    const urls = [
      subjectPhoto(0),
      subjectPhoto(1),
      compPhoto("99999999", 0),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.cluster_sizes["32118136"]).toBe(2);
    expect(out.cluster_sizes["99999999"]).toBe(1);
  });
});

describe("photoIdentityKey", () => {
  it("collapses resolution variants of the same photo", () => {
    const big = "https://ssl.cdn-redfin.com/photo/72/bigphoto/136/32118136_0.jpg";
    const isl = "https://ssl.cdn-redfin.com/photo/72/islphoto/136/genIslnoResize.32118136_0.jpg";
    expect(photoIdentityKey(big)).toBe(photoIdentityKey(isl));
  });

  it("does NOT collapse different photos of the same listing", () => {
    const p0 = "https://ssl.cdn-redfin.com/photo/72/bigphoto/136/32118136_0.jpg";
    const p1 = "https://ssl.cdn-redfin.com/photo/72/bigphoto/136/32118136_1.jpg";
    expect(photoIdentityKey(p0)).not.toBe(photoIdentityKey(p1));
  });

  it("does NOT collapse the same photo index across DIFFERENT listings (subject vs comp)", () => {
    const subj = "https://ssl.cdn-redfin.com/photo/72/bigphoto/136/32118136_0.jpg";
    const comp = "https://ssl.cdn-redfin.com/photo/72/bigphoto/999/99999999_0.jpg";
    expect(photoIdentityKey(subj)).not.toBe(photoIdentityKey(comp));
  });

  it("falls back to full URL for unrecognized filename shapes (no accidental collapse)", () => {
    const a = "https://ssl.cdn-redfin.com/photo/72/bigphoto/genMidShot.a.jpg";
    const b = "https://ssl.cdn-redfin.com/photo/72/bigphoto/genMidShot.b.jpg";
    expect(photoIdentityKey(a)).not.toBe(photoIdentityKey(b));
  });
});

describe("filterPropertyPhotos — resolution dedup", () => {
  it("keeps the highest-resolution variant when the same photo idx appears multiple times", () => {
    const urls = [
      subjectPhoto(0, "mb"),
      subjectPhoto(0, "big"),
      subjectPhoto(0, "isl"),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.kept.length).toBe(1);
    // islnoresize > bigphoto > mbphoto per redfinResolutionRank
    expect(out.kept[0]).toContain("islnoresize");
    expect(out.dropped_variant_dedup).toBe(2);
  });

  it("preserves distinct photo indices even when resolutions are mixed", () => {
    const urls = [
      subjectPhoto(0, "big"),
      subjectPhoto(1, "mb"),
      subjectPhoto(2, "isl"),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.kept.length).toBe(3);
    expect(out.dropped_variant_dedup).toBe(0);
  });
});

describe("Zillow CDN photos (recbHNKmFSiGXrfus / 1005 2nd St backfill)", () => {
  // Real Zillow CDN filenames are `<32-char-hex-hash>-<variant>.jpg` — no
  // extractable Redfin listing id (no "/home/<digits>" and no digit run
  // long enough to satisfy extractRedfinListingId), and Zillow serves the
  // same photo at several widths (-cc_ft_1536/-cc_ft_960/.../-p_e).
  const ZILLOW_PAGE =
    "https://www.zillow.com/homedetails/1005-2nd-St-Birmingham-AL-35214/938319_zpid/";
  const HASH = "8f1c2a9de1cb3a2f4e5d6c7b8a9f0e1d";
  const zillowPhoto = (variant: string) => `https://photos.zillowstatic.com/fp/${HASH}-${variant}.jpg`;

  it("extractRedfinListingId finds no id in a Zillow photo URL or page URL", () => {
    expect(extractRedfinListingId(zillowPhoto("cc_ft_1536"))).toBeNull();
    expect(extractRedfinListingId(ZILLOW_PAGE)).toBeNull();
  });

  it("photoIdentityKey collapses Zillow size variants to the same hash key", () => {
    const key1536 = photoIdentityKey(zillowPhoto("cc_ft_1536"));
    const key960 = photoIdentityKey(zillowPhoto("cc_ft_960"));
    const keyPe = photoIdentityKey(zillowPhoto("p_e"));
    expect(key1536).toBe(HASH);
    expect(key1536).toBe(key960);
    expect(key1536).toBe(keyPe);
  });

  it("photoIdentityKey does not collapse two DIFFERENT Zillow photos", () => {
    const other = "9a0b1c2d3e4f5061728394a5b6c7d8e9";
    expect(photoIdentityKey(zillowPhoto("cc_ft_1536"))).not.toBe(
      photoIdentityKey(`https://photos.zillowstatic.com/fp/${other}-cc_ft_1536.jpg`),
    );
  });

  it("zillowResolutionRank orders known size tags largest-first", () => {
    const r1536 = zillowResolutionRank(zillowPhoto("cc_ft_1536"));
    const r960 = zillowResolutionRank(zillowPhoto("cc_ft_960"));
    const r768 = zillowResolutionRank(zillowPhoto("cc_ft_768"));
    const r576 = zillowResolutionRank(zillowPhoto("cc_ft_576"));
    const r384 = zillowResolutionRank(zillowPhoto("cc_ft_384"));
    const rPe = zillowResolutionRank(zillowPhoto("p_e"));
    expect(r1536).toBeGreaterThan(r960);
    expect(r960).toBeGreaterThan(r768);
    expect(r768).toBeGreaterThan(r576);
    expect(r576).toBeGreaterThan(r384);
    expect(r384).toBeGreaterThan(rPe);
    expect(rPe).toBeGreaterThan(0);
  });

  it("FIRECRAWL_HTML_IMG_RE extracts Zillow CDN photo URLs from a listing-page HTML sample", () => {
    const html = `
      <div class="media-stream">
        <img src="${zillowPhoto("cc_ft_1536")}" alt="Front exterior" />
        <img src="${zillowPhoto("cc_ft_960")}" alt="Front exterior (small)" />
        <img src="${zillowPhoto("p_e")}" alt="Front exterior (thumb)" />
      </div>
    `;
    const matches = Array.from(new Set(html.match(FIRECRAWL_HTML_IMG_RE) ?? []));
    expect(matches).toEqual([
      zillowPhoto("cc_ft_1536"),
      zillowPhoto("cc_ft_960"),
      zillowPhoto("p_e"),
    ]);
  });

  it("filterPropertyPhotos keeps Zillow photos (does not drop them for lacking a Redfin id) and dedupes to the largest variant", () => {
    const urls = [zillowPhoto("cc_ft_1536"), zillowPhoto("cc_ft_960"), zillowPhoto("p_e")];
    const out = filterPropertyPhotos(urls, ZILLOW_PAGE);
    expect(out.dropped_chrome).toBe(0);
    expect(out.dropped_offcluster).toBe(0);
    expect(out.kept.length).toBe(1);
    expect(out.kept[0]).toBe(zillowPhoto("cc_ft_1536"));
    expect(out.dropped_variant_dedup).toBe(2);
  });

  it("filterPropertyPhotos keeps a Zillow photo alongside Redfin comps without cross-contamination", () => {
    const urls = [zillowPhoto("cc_ft_1536"), compPhoto("99999999", 0), compPhoto("99999999", 1)];
    const out = filterPropertyPhotos(urls, ZILLOW_PAGE);
    expect(out.kept).toContain(zillowPhoto("cc_ft_1536"));
    expect(out.kept).toContain(compPhoto("99999999", 0));
    expect(out.kept).toContain(compPhoto("99999999", 1));
    expect(out.dropped_offcluster).toBe(0);
  });
});

describe("filterPropertyPhotos — combined", () => {
  it("realistic Firecrawl scrape: chrome + comps + subject + variant dupes", () => {
    const urls = [
      // Chrome (5 dropped):
      "https://ssl.cdn-redfin.com/static/sprite.jpg",
      "https://ssl.cdn-redfin.com/agentphoto/abc.jpg",
      "https://ssl.cdn-redfin.com/static/logo.jpg",
      "https://ssl.cdn-redfin.com/assets/icons/heart.jpg",
      "https://ssl.cdn-redfin.com/static/placeholder.jpg",
      // Comps (4 dropped):
      compPhoto("99999999", 0),
      compPhoto("99999999", 1),
      compPhoto("88888888", 0),
      compPhoto("77777777", 0),
      // Subject — variants of indices 0/1/2 (1 dropped per variant
      // dedup, 3 kept):
      subjectPhoto(0, "mb"),
      subjectPhoto(0, "big"),
      subjectPhoto(1, "big"),
      subjectPhoto(2, "isl"),
    ];
    const out = filterPropertyPhotos(urls, SUBJECT_PAGE);
    expect(out.kept.length).toBe(3);
    expect(out.dropped_chrome).toBe(5);
    expect(out.dropped_offcluster).toBe(4);
    expect(out.dropped_variant_dedup).toBe(1);
  });
});

// ── publishablePhotos — security filter (2026-09-16) ─────────────────
//
// Google Street View Static URLs (streetViewUrl, above in this file's
// subject module) embed GOOGLE_MAPS_API_KEY as &key=... . Street View
// stays available to internal vision/rehab callers that use
// collectPhotos directly, but must never be persisted to a record
// field or returned from an HTTP route. publishablePhotos is the pure
// filter that draws that line.

describe("publishablePhotos", () => {
  it("drops streetview entries", () => {
    const photos: CollectedPhoto[] = [
      { url: "https://example.com/a.jpg", source: "firecrawl" },
      { url: "https://maps.googleapis.com/maps/api/streetview?location=x&key=SECRET", source: "streetview" },
    ];
    expect(publishablePhotos(photos)).toEqual([
      { url: "https://example.com/a.jpg", source: "firecrawl" },
    ]);
  });

  it("drops any URL containing key= regardless of source (belt and braces)", () => {
    const photos: CollectedPhoto[] = [
      { url: "https://example.com/b.jpg?key=SECRET", source: "listing" },
      { url: "https://example.com/c.jpg", source: "rentcast" },
    ];
    expect(publishablePhotos(photos)).toEqual([
      { url: "https://example.com/c.jpg", source: "rentcast" },
    ]);
  });

  it("keeps firecrawl, rentcast, and listing entries untouched", () => {
    const photos: CollectedPhoto[] = [
      { url: "https://cdn.example.com/1.jpg", source: "rentcast" },
      { url: "https://cdn.example.com/2.jpg", source: "firecrawl" },
      { url: "https://cdn.example.com/3.jpg", source: "listing" },
    ];
    expect(publishablePhotos(photos)).toEqual(photos);
  });

  it("preserves the relative order of surviving photos", () => {
    const photos: CollectedPhoto[] = [
      { url: "https://cdn.example.com/1.jpg", source: "rentcast" },
      { url: "https://maps.googleapis.com/maps/api/streetview?key=SECRET", source: "streetview" },
      { url: "https://cdn.example.com/2.jpg", source: "firecrawl" },
      { url: "https://cdn.example.com/3.jpg", source: "listing" },
    ];
    expect(publishablePhotos(photos).map((p) => p.url)).toEqual([
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
    ]);
  });

  it("returns an empty array when every photo is streetview or key-bearing", () => {
    const photos: CollectedPhoto[] = [
      { url: "https://maps.googleapis.com/maps/api/streetview?key=SECRET", source: "streetview" },
    ];
    expect(publishablePhotos(photos)).toEqual([]);
  });

  it("handles an empty input array", () => {
    expect(publishablePhotos([])).toEqual([]);
  });
});
