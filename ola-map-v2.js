/* =========================================================
   CBE Foods Ola Maps V2 shared helper
   - MapLibre loader
   - Netlify Ola proxy style/reverse/directions
   - Route drawing with Ola directions + straight-line fallback
   - Simple live rider/customer map renderer
========================================================= */
(function () {
  const PROXY_URL = "/.netlify/functions/ola-maps";
  const DEFAULT_STYLE = "default-light-standard";
  const ROUTE_CACHE = new Map();
  const MAPS = new Map();
  let mapLibrePromise = null;

  function clean(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function normalizePoint(source) {
    if (!source || typeof source !== "object") return null;
    const lat = toNumber(source.lat ?? source.latitude);
    const lng = toNumber(source.lng ?? source.lon ?? source.longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  function styleUrl(style = DEFAULT_STYLE) {
    return `${PROXY_URL}?type=style&style=${encodeURIComponent(style)}`;
  }

  function reverseUrl(point) {
    return `${PROXY_URL}?type=reverse&lat=${encodeURIComponent(point.lat)}&lng=${encodeURIComponent(point.lng)}`;
  }

  function directionsUrl(origin, destination) {
    return `${PROXY_URL}?type=directions&origin=${encodeURIComponent(origin.lat + "," + origin.lng)}&destination=${encodeURIComponent(destination.lat + "," + destination.lng)}&mode=driving&alternatives=false&steps=true&overview=full`;
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

  function decodePolyline(str, precision = 5) {
    if (!str || typeof str !== "string") return [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const coordinates = [];
    const factor = Math.pow(10, precision);

    while (index < str.length) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;

      result = 0;
      shift = 0;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;

      coordinates.push([lng / factor, lat / factor]);
    }

    return coordinates.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  }

  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = value => value * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function formatDistance(meters) {
    const value = Number(meters || 0);
    if (!Number.isFinite(value) || value <= 0) return "—";
    if (value < 1000) return `${Math.round(value)} m`;
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km`;
  }

  function formatDuration(seconds) {
    const value = Number(seconds || 0);
    if (!Number.isFinite(value) || value <= 0) return "—";
    const mins = Math.max(1, Math.round(value / 60));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  function getNumberFromDistance(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "object") return Number(value.value ?? value.distance ?? value.meters ?? 0) || 0;
    return Number(String(value).replace(/[^0-9.]/g, "")) || 0;
  }

  function getNumberFromDuration(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "object") return Number(value.value ?? value.duration ?? value.seconds ?? 0) || 0;
    return Number(String(value).replace(/[^0-9.]/g, "")) || 0;
  }

  function collectCoordinatesFromGeoJson(obj) {
    if (!obj || typeof obj !== "object") return [];
    if (obj.type === "LineString" && Array.isArray(obj.coordinates)) return obj.coordinates;
    if (obj.type === "Feature" && obj.geometry) return collectCoordinatesFromGeoJson(obj.geometry);
    if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
      return obj.features.flatMap(feature => collectCoordinatesFromGeoJson(feature));
    }
    return [];
  }

  function extractRouteData(data, origin, destination) {
    const fallbackCoords = [[origin.lng, origin.lat], [destination.lng, destination.lat]];
    const routes = data?.routes || data?.data?.routes || data?.result?.routes || [];
    const route = Array.isArray(routes) ? routes[0] : routes;
    let coords = [];
    let distanceMeters = 0;
    let durationSeconds = 0;

    const directEncoded =
      route?.overview_polyline?.points ||
      route?.overviewPolyline?.points ||
      route?.overview_polyline ||
      route?.overviewPolyline ||
      route?.polyline ||
      route?.encodedPolyline ||
      route?.geometry;

    if (typeof directEncoded === "string") {
      coords = decodePolyline(directEncoded, 5);
      if (!coords.length) coords = decodePolyline(directEncoded, 6);
    }

    if (!coords.length) coords = collectCoordinatesFromGeoJson(route?.geometry || route?.geojson || route?.routeGeoJson);

    const legs = Array.isArray(route?.legs) ? route.legs : [];
    if (!coords.length && legs.length) {
      const stepCoords = [];
      legs.forEach(leg => {
        (leg.steps || []).forEach(step => {
          const encoded = step.polyline?.points || step.polyline || step.encodedPolyline || step.geometry;
          if (typeof encoded === "string") {
            stepCoords.push(...decodePolyline(encoded, 5));
          } else {
            stepCoords.push(...collectCoordinatesFromGeoJson(encoded));
          }
        });
      });
      coords = stepCoords;
    }

    if (legs.length) {
      distanceMeters = legs.reduce((sum, leg) => sum + getNumberFromDistance(leg.distance), 0);
      durationSeconds = legs.reduce((sum, leg) => sum + getNumberFromDuration(leg.duration), 0);
    }

    if (!distanceMeters) distanceMeters = getNumberFromDistance(route?.distance || data?.distance);
    if (!durationSeconds) durationSeconds = getNumberFromDuration(route?.duration || data?.duration);
    if (!distanceMeters) distanceMeters = haversineMeters(origin, destination);
    if (!durationSeconds) durationSeconds = Math.round(distanceMeters / 6.5); // approx city-bike traffic fallback

    if (!Array.isArray(coords) || coords.length < 2) coords = fallbackCoords;
    coords = coords
      .map(point => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point.lng ?? point.lon ?? point.longitude), Number(point.lat ?? point.latitude)])
      .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (coords.length < 2) coords = fallbackCoords;

    return {
      coordinates: coords,
      distanceMeters,
      durationSeconds,
      distanceText: formatDistance(distanceMeters),
      durationText: formatDuration(durationSeconds),
      raw: data
    };
  }

  async function getRoute(originInput, destinationInput) {
    const origin = normalizePoint(originInput);
    const destination = normalizePoint(destinationInput);
    if (!origin || !destination) return null;
    const key = `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}>${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    if (ROUTE_CACHE.has(key)) return ROUTE_CACHE.get(key);

    let route;
    try {
      const response = await fetch(directionsUrl(origin, destination));
      const data = await response.json();
      if (!response.ok || data?.error || data?.message) throw new Error(data?.error || data?.message || "Directions failed");
      route = extractRouteData(data, origin, destination);
    } catch (error) {
      route = extractRouteData(null, origin, destination);
      route.fallback = true;
    }

    ROUTE_CACHE.set(key, route);
    return route;
  }

  function setMessage(messageEl, text, show = true) {
    if (!messageEl) return;
    messageEl.textContent = text || "";
    messageEl.style.display = show ? "flex" : "none";
  }

  function routeFeature(coordinates) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coordinates || [] },
      properties: {}
    };
  }

  async function renderRouteMap(options) {
    const container = typeof options.container === "string" ? document.getElementById(options.container) : options.container;
    const customer = normalizePoint(options.customer);
    const rider = normalizePoint(options.rider);
    const messageEl = typeof options.messageEl === "string" ? document.getElementById(options.messageEl) : options.messageEl;
    if (!container || !customer) return null;

    setMessage(messageEl, "Loading Ola map...");
    const maplibregl = await loadMapLibre();
    let view = MAPS.get(container.id || options.key || container);
    const centerPoint = rider || customer;

    if (!view) {
      const map = new maplibregl.Map({
        container,
        style: styleUrl(),
        center: [centerPoint.lng, centerPoint.lat],
        zoom: options.zoom || 15,
        attributionControl: false
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      view = { map, loaded: false, customerMarker: null, riderMarker: null, routeId: `route-${Math.random().toString(36).slice(2)}` };
      MAPS.set(container.id || options.key || container, view);
      await new Promise((resolve) => {
        map.on("load", () => { view.loaded = true; resolve(); });
        map.on("error", () => { setMessage(messageEl, "Ola map could not load. Check Netlify function and Ola key."); });
      });
      map.addSource(view.routeId, { type: "geojson", data: routeFeature([]) });
      map.addLayer({
        id: `${view.routeId}-line`,
        type: "line",
        source: view.routeId,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": options.routeColor || "#08A045", "line-width": options.routeWidth || 5, "line-opacity": 0.92 }
      });
    }

    if (view.map && view.map.resize) view.map.resize();

    const customerLngLat = [customer.lng, customer.lat];
    if (!view.customerMarker) {
      view.customerMarker = new maplibregl.Marker({ color: options.customerColor || "#8806CE" }).setLngLat(customerLngLat).addTo(view.map);
    } else {
      view.customerMarker.setLngLat(customerLngLat);
    }

    let route = null;
    if (rider) {
      const riderLngLat = [rider.lng, rider.lat];
      if (!view.riderMarker) {
        view.riderMarker = new maplibregl.Marker({ color: options.riderColor || "#08A045" }).setLngLat(riderLngLat).addTo(view.map);
      } else {
        view.riderMarker.setLngLat(riderLngLat);
      }
      route = await getRoute(rider, customer);
    } else {
      route = { coordinates: [customerLngLat], distanceText: "—", durationText: "—" };
    }

    if (view.map.getSource(view.routeId)) {
      view.map.getSource(view.routeId).setData(routeFeature(route.coordinates));
    }

    const bounds = new maplibregl.LngLatBounds();
    (route.coordinates && route.coordinates.length ? route.coordinates : [customerLngLat]).forEach(coord => bounds.extend(coord));
    if (rider) bounds.extend([rider.lng, rider.lat]);
    bounds.extend(customerLngLat);

    if (options.autoFollow && rider) {
      view.map.easeTo({ center: [rider.lng, rider.lat], zoom: options.followZoom || 16, duration: 450 });
    } else if (options.fit !== false) {
      view.map.fitBounds(bounds, { padding: options.padding || 48, maxZoom: options.maxZoom || 16, duration: 500 });
    }

    setMessage(messageEl, "", false);
    if (typeof options.onRoute === "function") options.onRoute(route);
    return { ...view, route };
  }

  function openExternalNavigation(destination, origin) {
    const dest = normalizePoint(destination);
    const start = normalizePoint(origin);
    if (!dest) return;
    const params = new URLSearchParams({ api: "1", destination: `${dest.lat},${dest.lng}`, travelmode: "driving" });
    if (start) params.set("origin", `${start.lat},${start.lng}`);
    window.open(`https://www.google.com/maps/dir/?${params.toString()}`, "_blank", "noopener,noreferrer");
  }

  window.CBEMapV2 = {
    PROXY_URL,
    styleUrl,
    reverseUrl,
    directionsUrl,
    loadMapLibre,
    normalizePoint,
    getRoute,
    renderRouteMap,
    openExternalNavigation,
    formatDistance,
    formatDuration,
    haversineMeters,
    decodePolyline
  };
})();
