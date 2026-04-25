import { describe, expect, it } from "vitest";
import {
  ALL_GENRES,
  capitalizeGenre,
  detectGenreFromPath,
  getAllBlobFolders,
  getGenreBlobFolder,
  getGenreFolderName,
  getGenreHashtag,
  GENRE_LABELS,
} from "./genre-utils";

describe("genre catalogue", () => {
  it("ALL_GENRES has the expected 10 entries", () => {
    expect(ALL_GENRES.length).toBe(10);
    expect(ALL_GENRES).toContain("action");
    expect(ALL_GENRES).toContain("cooking_channel");
    expect(ALL_GENRES).toContain("music_video");
  });

  it("GENRE_LABELS has a label for every genre", () => {
    for (const g of ALL_GENRES) {
      expect(typeof GENRE_LABELS[g]).toBe("string");
      expect(GENRE_LABELS[g]!.length).toBeGreaterThan(0);
    }
  });
});

describe("getGenreBlobFolder", () => {
  it("returns premiere/<folder> for canonical genres", () => {
    expect(getGenreBlobFolder("action")).toBe("premiere/action");
    expect(getGenreBlobFolder("romance")).toBe("premiere/romance");
  });

  it("maps cooking_channel → cooking_show (legacy quirk)", () => {
    expect(getGenreBlobFolder("cooking_channel")).toBe("premiere/cooking_show");
  });

  it("falls back to the input name when unknown", () => {
    expect(getGenreBlobFolder("unknown-genre")).toBe("premiere/unknown-genre");
  });
});

describe("getGenreFolderName", () => {
  it("returns the folder without the premiere/ prefix", () => {
    expect(getGenreFolderName("action")).toBe("action");
    expect(getGenreFolderName("cooking_channel")).toBe("cooking_show");
    expect(getGenreFolderName("unknown")).toBe("unknown");
  });
});

describe("detectGenreFromPath", () => {
  it("detects via mapped folder name (cooking_show → cooking_channel)", () => {
    expect(
      detectGenreFromPath("https://cdn.example.com/premiere/cooking_show/x.mp4"),
    ).toBe("cooking_channel");
  });

  it("detects via canonical folder match", () => {
    expect(
      detectGenreFromPath("https://cdn.example.com/premiere/action/clip.mp4"),
    ).toBe("action");
  });

  it("detects via /<folder>- pattern", () => {
    expect(detectGenreFromPath("/something/horror-clip-1.mp4")).toBe("horror");
  });

  it("returns null when nothing matches", () => {
    expect(detectGenreFromPath("/uploads/random.mp4")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectGenreFromPath("/PREMIERE/SCIFI/clip.mp4")).toBe("scifi");
  });
});

describe("getAllBlobFolders", () => {
  it("returns one path per genre, all under premiere/", () => {
    const folders = getAllBlobFolders();
    expect(folders.length).toBe(ALL_GENRES.length);
    for (const f of folders) {
      expect(f.startsWith("premiere/")).toBe(true);
    }
  });
});

describe("capitalizeGenre", () => {
  it("capitalizes simple genres", () => {
    expect(capitalizeGenre("action")).toBe("Action");
    expect(capitalizeGenre("scifi")).toBe("Scifi");
  });

  it("CamelCases underscored genres", () => {
    expect(capitalizeGenre("cooking_channel")).toBe("CookingChannel");
    expect(capitalizeGenre("music_video")).toBe("MusicVideo");
  });
});

describe("getGenreHashtag", () => {
  it("prefixes with AIGlitch and removes underscores", () => {
    expect(getGenreHashtag("romance")).toBe("AIGlitchRomance");
    expect(getGenreHashtag("music_video")).toBe("AIGlitchMusicVideo");
  });
});
