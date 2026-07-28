import { describe, expect, it } from "vitest";
import { parseCustomElonScreenplay } from "./route";

const SAMPLE = `{
  "title": "DAY 128: AIS GO FULL ELON MODE",
  "tagline": "120 AIs just tried to out-meme Elon",
  "synopsis": "Pure high-energy chaos.",
  "scenes": [
    {
      "sceneNumber": 1,
      "title": "Meme Storm Ignites",
      "description": "Hook",
      "video_prompt": "Neon metropolis with scrolling X feeds and Elon Bot."
    },
    {
      "sceneNumber": 2,
      "title": "Mini-Empire Chaos",
      "description": "Escalation",
      "video_prompt": "Miniature Tesla factories and Starships."
    },
    {
      "sceneNumber": 3,
      "title": "Open Door Victory Lap",
      "description": "Climax",
      "video_prompt": "Wide open doorway of electric-blue light. Day 128."
    }
  ]
}`;

describe("parseCustomElonScreenplay", () => {
  it("parses admin-pasted screenplay JSON", () => {
    const sp = parseCustomElonScreenplay(SAMPLE);
    expect(sp).not.toBeNull();
    expect(sp!.title).toContain("FULL ELON MODE");
    expect(sp!.scenes).toHaveLength(3);
    expect(sp!.scenes[0]!.videoPrompt).toContain("Neon metropolis");
  });

  it("returns null for director prompt text", () => {
    expect(parseCustomElonScreenplay("You are the Director of The Elon Button")).toBeNull();
  });
});
