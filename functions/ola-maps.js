const OLA_STYLE_URL =
  "https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json";

const OLA_REVERSE_URL =
  "https://api.olamaps.io/places/v1/reverse-geocode";

const OLA_DIRECTIONS_URL =
  "https://api.olamaps.io/routing/v1/directions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}

function isAllowedOlaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (
        url.hostname.endsWith("olamaps.io") ||
        url.hostname.endsWith("olakrutrim.com")
      )
    );
  } catch {
    return false;
  }
}

function stripApiKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("api_key");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function withApiKey(rawUrl, apiKey) {
  const url = new URL(rawUrl);
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

function normalizeMapLibrePlaceholders(rawUrl) {
  return String(rawUrl || "")
    .replace(/%257B/gi, "{")
    .replace(/%257D/gi, "}")
    .replace(/%7B/gi, "{")
    .replace(/%7D/gi, "}");
}

function proxyUrl(rawUrl, origin) {
  const cleanUrl = normalizeMapLibrePlaceholders(stripApiKey(String(rawUrl)));

  // Keep MapLibre placeholders readable:
  // {z}, {x}, {y}, {fontstack}, {range}
  const encodedUrl = encodeURIComponent(cleanUrl)
    .replace(/%7B/gi, "{")
    .replace(/%7D/gi, "}");

  return `${origin}/ola-maps?type=proxy&url=${encodedUrl}`;
}

function rewriteOlaUrls(value, origin) {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteOlaUrls(item, origin));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = rewriteOlaUrls(item, origin);
    }
    return output;
  }

  if (typeof value === "string" && isAllowedOlaUrl(value)) {
    return proxyUrl(value, origin);
  }

  return value;
}

async function fetchOla(rawUrl, apiKey, origin) {
  if (!isAllowedOlaUrl(rawUrl)) {
    return jsonResponse({ message: "Blocked non-Ola URL" }, 403);
  }

  const upstreamUrl = withApiKey(rawUrl, apiKey);

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "Accept": "*/*",
      "Origin": origin,
      "Referer": origin + "/",
      "User-Agent": "CBEFoods-Cloudflare-Pages-Proxy",
    },
  });

  const contentType = upstream.headers.get("content-type") || "";

  if (
    contentType.includes("application/json") ||
    contentType.includes("text/json") ||
    upstreamUrl.endsWith(".json")
  ) {
    const text = await upstream.text();

    try {
      const data = JSON.parse(text);
      const rewritten = rewriteOlaUrls(data, origin);
      return jsonResponse(rewritten, upstream.status);
    } catch {
      return new Response(text, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": contentType || "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=60",
        },
      });
    }
  }

  const body = await upstream.arrayBuffer();

  return new Response(body, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const apiKey = env.OLA_MAPS_API_KEY;

  if (!apiKey) {
    return jsonResponse(
      { message: "Missing Cloudflare env var OLA_MAPS_API_KEY" },
      500
    );
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const type = url.searchParams.get("type") || "style";

  try {
    if (type === "style") {
      return await fetchOla(OLA_STYLE_URL, apiKey, origin);
    }

    if (type === "proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return jsonResponse({ message: "Missing proxy url" }, 400);
      }
      return await fetchOla(targetUrl, apiKey, origin);
    }

    if (type === "reverse") {
      const lat = url.searchParams.get("lat");
      const lng = url.searchParams.get("lng");

      if (!lat || !lng) {
        return jsonResponse({ message: "lat and lng are required" }, 400);
      }

      const reverseUrl =
        `${OLA_REVERSE_URL}?latlng=${encodeURIComponent(`${lat},${lng}`)}` +
        `&language=en`;

      return await fetchOla(reverseUrl, apiKey, origin);
    }

    if (type === "directions") {
      const originLat = url.searchParams.get("originLat");
      const originLng = url.searchParams.get("originLng");
      const destLat = url.searchParams.get("destLat");
      const destLng = url.searchParams.get("destLng");

      if (!originLat || !originLng || !destLat || !destLng) {
        return jsonResponse(
          { message: "originLat, originLng, destLat and destLng are required" },
          400
        );
      }

      const directionsUrl =
        `${OLA_DIRECTIONS_URL}?origin=${encodeURIComponent(`${originLat},${originLng}`)}` +
        `&destination=${encodeURIComponent(`${destLat},${destLng}`)}` +
        `&mode=driving`;

      return await fetchOla(directionsUrl, apiKey, origin);
    }

    return jsonResponse({ message: "Unknown Ola proxy type" }, 400);
  } catch (error) {
    return jsonResponse(
      {
        message: "Ola proxy failed",
        error: error.message || String(error),
      },
      500
    );
  }
}
