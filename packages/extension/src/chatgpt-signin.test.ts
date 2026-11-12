import { expect, test } from "bun:test";
import { beginChatGptConnect, CHATGPT_CALLBACK_PERMISSION, isChatGptCallback } from "./chatgpt-signin.js";

const attempt = { tabId: 12, attemptId: "attempt", callbackUri: "http://127.0.0.1:1455/auth/callback", expiresAt: Date.now() + 60_000 };
test("ChatGPT callback is accepted only from its exact pending tab and callback URL", () => {
  expect(isChatGptCallback(12, "http://127.0.0.1:1455/auth/callback?code=secret&state=state", attempt)).toBe(true);
  expect(isChatGptCallback(13, "http://127.0.0.1:1455/auth/callback?code=secret", attempt)).toBe(false);
  expect(isChatGptCallback(12, "http://localhost:1455/auth/callback?code=secret", attempt)).toBe(false);
  expect(isChatGptCallback(12, "http://127.0.0.1:1455/other?code=secret", attempt)).toBe(false);
});

test("Connect asks for the callback permission before awaiting anything, and stops if it is refused", async () => {
  const calls: string[] = [];
  const api = (granted: boolean) => ({
    permissions: { request: async (request: { origins: string[] }) => { calls.push(`request ${request.origins.join(",")}`); return granted; } },
    runtime: { sendMessage: async (message: { type: string }) => { calls.push(`send ${message.type}`); return { ok: true }; } },
  });
  const refused = beginChatGptConnect(api(false));
  // Requested synchronously, so the prompt is still inside the click's user gesture.
  expect(calls).toEqual([`request ${CHATGPT_CALLBACK_PERMISSION}`]);
  await expect(refused).rejects.toThrow(/127\.0\.0\.1/);
  expect(calls).toEqual([`request ${CHATGPT_CALLBACK_PERMISSION}`]);
  calls.length = 0;
  await beginChatGptConnect(api(true));
  expect(calls).toEqual([`request ${CHATGPT_CALLBACK_PERMISSION}`, "send chatgptSignIn"]);
  expect(CHATGPT_CALLBACK_PERMISSION).toBe("http://127.0.0.1/*");
});
