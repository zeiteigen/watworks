import { expect, test } from "bun:test";
import { isChatGptCallback } from "./chatgpt-signin.js";

const attempt = { tabId: 12, attemptId: "attempt", callbackUri: "http://127.0.0.1:1455/auth/callback", expiresAt: Date.now() + 60_000 };
test("ChatGPT callback is accepted only from its exact pending tab and callback URL", () => {
  expect(isChatGptCallback(12, "http://127.0.0.1:1455/auth/callback?code=secret&state=state", attempt)).toBe(true);
  expect(isChatGptCallback(13, "http://127.0.0.1:1455/auth/callback?code=secret", attempt)).toBe(false);
  expect(isChatGptCallback(12, "http://localhost:1455/auth/callback?code=secret", attempt)).toBe(false);
  expect(isChatGptCallback(12, "http://127.0.0.1:1455/other?code=secret", attempt)).toBe(false);
});
