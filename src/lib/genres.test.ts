import { describe, expect, it } from "vitest";
import {
  ALL_GENRES,
  capitalizeGenre,
  detectGenreFromPath,
  GENRE_LABELS,
  getAllBlobFolders,
  getGenreBlobFolder,
  getGenreFolderName,
  getGenreHashtag,
} from "./genres";

describe("ALL_GENRES + GENRE_LABELS", () => {
  it("covers 10 genres with matching labels", () => {
    expect(ALL_GENRES).toHaveLength(10);
    for (const genre of ALL_GENRES) {
      expect(GENRE_LABELS[genre]).toBeTruthy();
    }
  });

  it("cooking_channel label is human-readable 'Cooking Show'", () => {
    expect(GENRE_LABELS.cooking_channel).toBe("Cooking Show");
  });
});

describe("getGenreBlobFolder / getGenreFolderName", () => {
  it("maps cooking_channel to the cooking_show folder", () => {
    expect(getGenreBlobFolder("cooking_channel")).toBe("premiere/cooking_show");
    expect(getGenreFolderName("cooking_channel")).toBe("cooking_show");
  });

  it("identity map for straight-through genres", () => {
    expect(getGenreBlobFolder("action")).toBe("premiere/action");
    expect(getGenreFolderName("scifi")).toBe("scifi");
  });

  it("falls back to the raw genre for unknown names", () => {
    expect(getGenreFolderName("unknown_genre")).toBe("unknown_genre");
    expect(getGenreBlobFolder("something_new")).toBe("premiere/something_new");
  });
});

describe("detectGenreFromPath", () => {
  it("detects renamed folder (cooking_show → cooking_channel)", () => {
    expect(detectGenreFromPath("premiere/cooking_show/abc.mp4")).toBe(
      "cooking_channel",
    );
  });

  it("detects each standard folder", () => {
    for (const genre of ["action", "scifi", "romance", "family", "horror", "comedy", "drama"]) {
      expect(detectGenreFromPath(`premiere/${genre}/file.mp4`)).toBe(genre);
    }
  });

  it("case-insensitive match", () => {
    expect(detectGenreFromPath("PREMIERE/ACTION/x.mp4")).toBe("action");
  });

  it("dash variant matches", () => {
    expect(detectGenreFromPath("premiere/scifi-trailer.mp4")).toBe("scifi");
  });

  it("returns null when no genre token present", () => {
    expect(detectGenreFromPath("random/thing.mp4")).toBeNull();
  });
});

describe("getAllBlobFolders", () => {
  it("returns one folder per genre under premiere/", () => {
    const folders = getAllBlobFolders();
    expect(folders).toHaveLength(ALL_GENRES.length);
    expect(folders).toContain("premiere/cooking_show");
    expect(folders).toContain("premiere/music_video");
    for (const f of folders) expect(f.startsWith("premiere/")).toBe(true);
  });
});

describe("capitalizeGenre + getGenreHashtag", () => {
  it("single-word genres capitalize", () => {
    expect(capitalizeGenre("action")).toBe("Action");
    expect(getGenreHashtag("action")).toBe("AIGlitchAction");
  });

  it("underscored genres drop underscore + capitalize each word", () => {
    expect(capitalizeGenre("cooking_channel")).toBe("CookingChannel");
    expect(capitalizeGenre("music_video")).toBe("MusicVideo");
    expect(getGenreHashtag("music_video")).toBe("AIGlitchMusicVideo");
  });
});
