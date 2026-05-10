/* =========================================================
   Ola Maps Netlify proxy
   Option B: keeps OLA_MAPS_API_KEY on Netlify server side.

   Required Netlify environment variable:
   OLA_MAPS_API_KEY=your_ola_maps_key

   Why v2 exists:
   Some Ola Maps keys are domain-restricted. Netlify Functions do not
   automatically send the browser page as the request domain, so Ola can
   return {"message":"Domain is not allowed."}. This proxy now sends
   Origin/Referer headers using the current Netlify site URL.
========================================================= */
const OLA_HOSTS = new Set(["api.olamaps.io", "app.olamaps.io"]);
const DEFAULT_STYLE = "default-light-standard";

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  };
}

function text(statusCode, body, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      ...extraHeaders
    },
    body
  };
}

function getOrigin(event) {
  const proto = event.headers["x-forwarded-proto"] || "https";
  const host = event.headers.host || "";
  return `${proto}://${host}`;
}

function olaRequestHeaders(event, origin, extra = {}) {
  return {
    "Accept": event.headers.accept || "application/json, text/plain, */*",
    "Origin": origin,
    "Referer": `${origin}/`,
    "User-Agent": "cbefoods-ola-proxy/2.0",
    ...extra
  };
}

function assertOlaUrl(raw) {
  const url = new URL(String(raw || "").replace("https://app.olamaps.io", "https://api.olamaps.io"));
  if (!OLA_HOSTS.has(url.hostname)) throw new Error("Only Ola Maps URLs can be proxied.");
  return url;
}

function withApiKey(url, apiKey) {
  url.searchParams.delete("api_key");
  url.searchParams.set("api_key", apiKey);
  return url;
}

function proxyUrlFor(rawUrl, origin) {
  const clean = String(rawUrl || "").replace("https://app.olamaps.io", "https://api.olamaps.io");
  const encoded = encodeURIComponent(clean).replace(/%7B/g, "{").replace(/%7D/g, "}");
  return `${origin}/.netlify/functions/ola-maps?type=proxy&url=${encoded}`;
}

function rewriteStyleUrls(value, origin) {
  if (Array.isArray(value)) return value.map(item => rewriteStyleUrls(item, origin));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = rewriteStyleUrls(child, origin);
    return output;
  }
  if (typeof value === "string" && value.includes("olamaps.io")) {
    return proxyUrlFor(value, origin);
  }
  return value;
}

async function fetchJson(url, event, origin, cacheControl = "no-store") {
  const response = await fetch(url, {
    headers: olaRequestHeaders(event, origin)
  });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    data = { error: "Ola Maps returned a non-JSON response", status: response.status };
  }
  return json(response.status, data, { "Cache-Control": cacheControl });
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") return text(200, "ok");

  const apiKey = process.env.OLA_MAPS_API_KEY || process.env.OLA_API_KEY || "";
  if (!apiKey) return json(500, { error: "Missing Netlify env var OLA_MAPS_API_KEY" });

  const q = event.queryStringParameters || {};
  const type = q.type || q.action || "style";
  const origin = getOrigin(event);

  try {
    if (type === "style") {
      const styleName = q.style || DEFAULT_STYLE;
      const styleUrl = withApiKey(new URL(`https://api.olamaps.io/tiles/vector/v1/styles/${styleName}/style.json`), apiKey);
      const response = await fetch(styleUrl, {
        headers: olaRequestHeaders(event, origin)
      });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        data = { error: "Ola Maps returned a non-JSON style response", status: response.status };
      }
      if (!response.ok) return json(response.status, data);
      return json(200, rewriteStyleUrls(data, origin), { "Cache-Control": "public, max-age=3600" });
    }

    if (type === "proxy") {
      const target = assertOlaUrl(q.url);
      withApiKey(target, apiKey);
      const response = await fetch(target, {
        headers: olaRequestHeaders(event, origin, {
          "Accept": event.headers.accept || "*/*"
        })
      });
      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const cacheControl = response.headers.get("cache-control") || "public, max-age=86400";
      const body = Buffer.from(await response.arrayBuffer()).toString("base64");
      return {
        statusCode: response.status,
        isBase64Encoded: true,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": contentType,
          "Cache-Control": cacheControl
        },
        body
      };
    }

    if (type === "reverse") {
      const lat = q.lat || q.latitude;
      const lng = q.lng || q.lon || q.longitude;
      if (!lat || !lng) return json(400, { error: "lat and lng are required" });
      const url = withApiKey(new URL("https://api.olamaps.io/places/v1/reverse-geocode"), apiKey);
      url.searchParams.set("latlng", `${lat},${lng}`);
      url.searchParams.set("language", q.language || "en");
      return fetchJson(url, event, origin, "no-store");
    }

    if (type === "directions") {
      const originPoint = q.origin;
      const destinationPoint = q.destination;
      if (!originPoint || !destinationPoint) return json(400, { error: "origin and destination are required" });
      const url = withApiKey(new URL("https://api.olamaps.io/routing/v1/directions"), apiKey);
      url.searchParams.set("origin", originPoint);
      url.searchParams.set("destination", destinationPoint);
      url.searchParams.set("mode", q.mode || "driving");
      url.searchParams.set("alternatives", q.alternatives || "false");
      url.searchParams.set("steps", q.steps || "false");
      url.searchParams.set("overview", q.overview || "full");
      return fetchJson(url, event, origin, "no-store");
    }

    return json(400, { error: `Unsupported Ola Maps proxy type: ${type}` });
  } catch (error) {
    return json(500, { error: error.message || "Ola Maps proxy failed" });
  }
};
