export type ZoomCredentials = {
  accountId: string;
  clientId: string;
  clientSecret: string;
};

export type ZoomAccessToken = {
  accessToken: string;
  scopes: string[];
};

export async function getZoomAccessToken(
  credentials: ZoomCredentials,
  fetcher: typeof fetch = fetch
): Promise<ZoomAccessToken> {

  const { accountId, clientId, clientSecret } = credentials;

  if (
    !accountId?.trim() ||
    !clientId?.trim() ||
    !clientSecret?.trim()
  ) {
    throw new Error("ZOOM_NOT_CONFIGURED");
  }

  const url = new URL("https://zoom.us/oauth/token");

  url.searchParams.set(
    "grant_type",
    "account_credentials"
  );

  url.searchParams.set(
    "account_id",
    accountId.trim()
  );

  const response = await fetcher(url.toString(), {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + btoa(`${clientId}:${clientSecret}`)
    }
  });

  if (!response.ok) {
    throw new Error("ZOOM_AUTH_FAILED");
  }

  const data = await response.json().catch(() => null);

  if (
    !data ||
    typeof data.access_token !== "string" ||
    !data.access_token.trim()
  ) {
    throw new Error("ZOOM_INVALID_TOKEN");
  }

  return {
    accessToken: data.access_token,
    scopes:
      typeof data.scope === "string"
        ? data.scope.split(/\s+/).filter(Boolean)
        : []
  };
}