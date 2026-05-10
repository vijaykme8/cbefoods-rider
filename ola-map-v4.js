/* =========================================================
   CBE Foods Ola Maps V4 shared helper
   Swiggy-like map behavior foundation:
   - Direct Ola map tiles in browser for speed
   - Cloudflare Pages Function only for reverse/directions/config
   - MapLibre loader
========================================================= */
(function () {
  const PROXY_URL = "/ola-maps";
  const OLA_STYLE_URL = "https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json";
  let mapLibrePromise = null;
  let browserKeyPromise = null;

  function clean(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function isOlaUrl(rawUrl) {
    const url = String(rawUrl || "");
    return url.includes("olamaps.io") || url.includes("olakrutrim.com");
  }

  async function getBrowserKey() {
    if (window.CBE_OLA_BROWSER_API_KEY) {
      return clean(window.CBE_OLA_BROWSER_API_KEY);
    }

    if (browserKeyPromise) return browserKeyPromise;

    browserKeyPromise = fetch(`${PROXY_URL}?type=config`, { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(`Ola config failed: ${response.status}`);
        const data = await response.json();
        const key = clean(data.apiKey || data.olaMapsApiKey || data.key);
        if (!key) throw new Error("Ola browser key missing from config response");
        window.CBE_OLA_BROWSER_API_KEY = key;
        return key;
      });

    return browserKeyPromise;
  }

  function withApiKey(rawUrl, apiKey) {
    try {
      const url = new URL(rawUrl);
      if (isOlaUrl(url.href) && apiKey && !url.searchParams.get("api_key")) {
        url.searchParams.set("api_key", apiKey);
      }
      return url.toString();
    } catch (_) {
      return rawUrl;
    }
  }

  async function styleUrl() {
    const apiKey = await getBrowserKey();
    return withApiKey(OLA_STYLE_URL, apiKey);
  }

  async function transformRequest(url) {
    const apiKey = await getBrowserKey();
    return { url: withApiKey(url, apiKey) };
  }

  function transformRequestSync(url) {
    const apiKey = clean(window.CBE_OLA_BROWSER_API_KEY);
    return { url: withApiKey(url, apiKey) };
  }

  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (mapLibrePromise) return mapLibrePromise;

    mapLibrePromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-cbe-maplibre="true"]') || document.querySelector('script[data-maplibre="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(window.maplibregl));
        existing.addEventListener("error", () => reject(new Error("MapLibre failed to load")));
        if (window.maplibregl) resolve(window.maplibregl);
        return;
      }

      const script = document.createElement("script");
      script.src = "https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.js";
      script.async = true;
      script.defer = true;
      script.dataset.cbeMaplibre = "true";
      script.onload = () => resolve(window.maplibregl);
      script.onerror = () => reject(new Error("MapLibre failed to load"));
      document.head.appendChild(script);
    });

    return mapLibrePromise;
  }

  async function createMap(options) {
    const maplibregl = await loadMapLibre();
    await getBrowserKey();
    const style = await styleUrl();

    const map = new maplibregl.Map({
      container: options.container,
      style,
      center: options.center,
      zoom: options.zoom || 16,
      attributionControl: false,
      transformRequest: transformRequestSync
    });

    if (options.controls !== false) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    }

    return { map, maplibregl };
  }

  async function reverse(point) {
    const response = await fetch(`${PROXY_URL}?type=reverse&lat=${encodeURIComponent(point.lat)}&lng=${encodeURIComponent(point.lng)}`);
    if (!response.ok) throw new Error(`Reverse geocode failed: ${response.status}`);
    return response.json();
  }

  async function directions(origin, destination) {
    const url = `${PROXY_URL}?type=directions&originLat=${encodeURIComponent(origin.lat)}&originLng=${encodeURIComponent(origin.lng)}&destLat=${encodeURIComponent(destination.lat)}&destLng=${encodeURIComponent(destination.lng)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Directions failed: ${response.status}`);
    return response.json();
  }

  window.CBEOlaMapV4 = {
    createMap,
    loadMapLibre,
    getBrowserKey,
    reverse,
    directions,
    withApiKey,
    PROXY_URL
  };
})();
