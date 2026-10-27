import { describe, expect, it } from "vitest";
import { isMicrosoftOAuthUrl } from "../services/tool-access/oauth/metadata.js";
import {
  normalizeOAuthProviderError,
  oauthProviderErrorMessage,
} from "../services/tool-access/oauth/provider-errors.js";

describe("OAuth Resource Indicators and Provider Handling", () => {
  describe("isMicrosoftOAuthUrl", () => {
    it.each([
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/tenant-id-123/oauth2/v2.0/token",
      "https://login.microsoft.com/v2.0",
      "https://login.windows.net/tenant-id-123/oauth2/token",
      "https://custom.login.microsoftonline.com/oauth2/v2.0/authorize",
    ])("recognizes Microsoft Entra ID endpoint %s", (url) => {
      expect(isMicrosoftOAuthUrl(url)).toBe(true);
    });

    it.each([
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://github.com/login/oauth/authorize",
      "https://app.asana.com/-/oauth_authorize",
      "https://mcp.example.com/oauth/authorize",
      "",
      null,
      undefined,
    ])("rejects non-Microsoft endpoint %s", (url) => {
      expect(isMicrosoftOAuthUrl(url)).toBe(false);
    });
  });

  describe("RFC 8707 provider error handling", () => {
    it("recognizes and normalizes invalid_target error code", () => {
      expect(normalizeOAuthProviderError("invalid_target")).toBe("invalid_target");
    });

    it("maps invalid_target to a friendly error message", () => {
      expect(
        oauthProviderErrorMessage(
          "invalid_target",
          "The authorization server denied the request.",
        ),
      ).toBe("The authorization server rejected the requested resource target.");
    });
  });
});
