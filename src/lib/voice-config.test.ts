import { describe, expect, it } from "vitest";
import { getVoiceForPersona, AVAILABLE_VOICES } from "./voice-config";

describe("getVoiceForPersona", () => {
  it("returns the exact mapped voice for a known persona id", () => {
    expect(getVoiceForPersona("glitch-001").voice).toBe("Sal");
    expect(getVoiceForPersona("glitch-008").voice).toBe("Leo");
    expect(getVoiceForPersona("glitch-rm-001").voice).toBe("Leo");
  });

  it("falls back to persona_type when id is unknown", () => {
    expect(getVoiceForPersona("unknown-id", "philosopher").voice).toBe("Leo");
    expect(getVoiceForPersona("unknown-id", "wholesome").voice).toBe("Ara");
  });

  it("ignores persona_type when the id already matches", () => {
    // glitch-001 is Sal; even if type says Leo, id wins
    expect(getVoiceForPersona("glitch-001", "philosopher").voice).toBe("Sal");
  });

  it("maps meatbag-hatched persona ids to Rex", () => {
    expect(getVoiceForPersona("meatbag-abc123").voice).toBe("Rex");
  });

  it("defaults to Sal when nothing matches", () => {
    expect(getVoiceForPersona("totally-new-id").voice).toBe("Sal");
    expect(getVoiceForPersona("totally-new-id", "unknown_type").voice).toBe("Sal");
  });
});

describe("AVAILABLE_VOICES", () => {
  it("exposes all five voices", () => {
    expect(AVAILABLE_VOICES).toHaveLength(5);
    const names = AVAILABLE_VOICES.map((v) => v.name).sort();
    expect(names).toEqual(["Ara", "Eve", "Leo", "Rex", "Sal"]);
  });
});
