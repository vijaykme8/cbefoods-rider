/* =========================================================
   CBE Foods Rider PWA
   Requires:
   - firebase-config.js
   - firebase-app-compat.js
   - firebase-auth-compat.js
   - firebase-firestore-compat.js
========================================================= */
(function () {
  const STORE_ID = window.TIFFIN_STORE_ID || "main";
  const LIVE_LOCATION_SYNC_MIN_MS = 20 * 1000;
  const $ = id => document.getElementById(id);

  const STATUS_LABELS = {
    confirmed: "Confirmed",
    preparing: "Preparing",
    out_for_delivery: "On the way",
    delivered: "Delivered",
    cancelled: "Cancelled",
    payment_failed: "Payment failed"
  };

  let auth;
  let db;
  let confirmationResult = null;
  let recaptchaVerifier = null;
  let riderProfile = null;
  let riderUnsubs = [];
  let assignedOrders = [];
  let lastAssignedIds = new Set();
  let bootedOrdersOnce = false;
  let soundEnabled = true;
  let riderMaps = new Map();
  let activeNavigationOrderId = "";
  let liveWatchId = null;
  let latestRiderLocation = null;
  let lastLiveLocationWriteAt = 0;

  function initFirebase() {
    if (!window.firebase || !window.TIFFIN_FIREBASE_CONFIG) {
      showFatal("Firebase config is missing. Check firebase-config.js and internet connection.");
      return false;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.TIFFIN_FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();
      try { db.enablePersistence({ synchronizeTabs: true }); } catch (_) {}
      return true;
    } catch (error) {
      showFatal(error.message || "Firebase failed to start.");
      return false;
    }
  }

  function showFatal(message) {
    $("connectionText").textContent = message;
    toast(message);
  }

  function clean(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function escapeHTML(value) {
    return clean(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function phone10(value) {
    const digits = clean(value).replace(/\D/g, "");
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  function e164(value) {
    const p = phone10(value);
    return p ? `+91${p}` : "";
  }

  function money(value) {
    return `₹${Number(value || 0).toLocaleString("en-IN")}`;
  }

  function toDate(value) {
    if (!value) return new Date();
    if (typeof value.toDate === "function") return value.toDate();
    if (value.seconds) return new Date(value.seconds * 1000);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  function isToday(value) {
    return toDate(value).toDateString() === new Date().toDateString();
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status || "Confirmed";
  }

  function orderTotal(order) {
    return Number(order.totals?.total ?? order.total ?? 0);
  }

  function orderCustomerPhone(order) {
    return clean(order.customerPhone || order.customer?.phone || order.customer?.contact || order.phone);
  }

  function orderCustomerName(order) {
    return clean(order.customerName || order.customer?.name || order.name || "Customer");
  }

  function orderAddress(order) {
    return clean(order.address || order.deliveryLocation?.fullAddress || order.deliveryLocation?.displayAddress || order.customer?.address || "");
  }


  function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  function normalizeLatLng(source) {
    if (!source || typeof source !== "object") return null;
    const lat = toNumber(source.lat ?? source.latitude);
    const lng = toNumber(source.lng ?? source.lon ?? source.longitude);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  }

  function orderPoint(order) {
    return normalizeLatLng(order?.deliveryLocation) || normalizeLatLng(order?.location) || null;
  }

  function riderPoint(order) {
    return normalizeLatLng(order?.riderLocation || { lat: order?.riderLat, lng: order?.riderLng }) || latestRiderLocation || normalizeLatLng(riderProfile?.location || { lat: riderProfile?.lat, lng: riderProfile?.lng });
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

  function collectCoordinatesFromGeoJson(obj) {
    if (!obj || typeof obj !== "object") return [];
    if (obj.type === "LineString" && Array.isArray(obj.coordinates)) return obj.coordinates;
    if (obj.type === "Feature" && obj.geometry) return collectCoordinatesFromGeoJson(obj.geometry);
    if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
      return obj.features.flatMap(feature => collectCoordinatesFromGeoJson(feature));
    }
    return [];
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

  function routeNumber(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    if (typeof value === "object") return Number(value.value ?? value.distance ?? value.meters ?? value.duration ?? value.seconds ?? 0) || 0;
    return Number(String(value).replace(/[^0-9.]/g, "")) || 0;
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
      distanceMeters = legs.reduce((sum, leg) => sum + routeNumber(leg.distance), 0);
      durationSeconds = legs.reduce((sum, leg) => sum + routeNumber(leg.duration), 0);
    }

    if (!distanceMeters) distanceMeters = routeNumber(route?.distance || data?.distance);
    if (!durationSeconds) durationSeconds = routeNumber(route?.duration || data?.duration);
    if (!distanceMeters) distanceMeters = haversineMeters(origin, destination);
    if (!durationSeconds) durationSeconds = Math.round(distanceMeters / 6.5);

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

  async function getRoute(origin, destination) {
    if (!origin || !destination) return null;
    try {
      const data = await window.CBEOlaMapV4.directions(origin, destination);
      const route = extractRouteData(data, origin, destination);
      route.fallback = false;
      return route;
    } catch (error) {
      const route = extractRouteData(null, origin, destination);
      route.fallback = true;
      return route;
    }
  }

  function routeFeature(coordinates) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: coordinates || [] },
      properties: {}
    };
  }

  async function ensureRiderMap(container, center, options = {}) {
    const containerEl = typeof container === "string" ? document.getElementById(container) : container;
    if (!containerEl || !window.CBEOlaMapV4) return null;
    const key = containerEl.id || containerEl.dataset.riderMapOrder || "rider-map";
    let store = riderMaps.get(key);
    if (store && store.map) {
      setTimeout(() => store.map.resize(), 80);
      return store;
    }

    const created = await window.CBEOlaMapV4.createMap({
      container: containerEl,
      center: [center.lng, center.lat],
      zoom: options.zoom || 15,
      controls: options.controls !== false
    });

    store = {
      map: created.map,
      maplibregl: created.maplibregl,
      markers: {},
      loaded: false
    };
    riderMaps.set(key, store);

    await new Promise(resolve => {
      if (created.map.loaded()) return resolve();
      created.map.once("load", resolve);
    });
    store.loaded = true;
    return store;
  }

  function updateMarker(store, name, point, color) {
    if (!store || !point) return;
    const lngLat = [point.lng, point.lat];
    if (store.markers[name]) {
      store.markers[name].setLngLat(lngLat);
      return;
    }
    store.markers[name] = new store.maplibregl.Marker({ color })
      .setLngLat(lngLat)
      .addTo(store.map);
  }

  function updateRouteLayer(store, coordinates, color = "#08A045") {
    if (!store || !store.map || !Array.isArray(coordinates)) return;
    const sourceId = "delivery-route";
    const layerId = "delivery-route-line";
    const data = routeFeature(coordinates);
    if (store.map.getSource(sourceId)) {
      store.map.getSource(sourceId).setData(data);
    } else {
      store.map.addSource(sourceId, { type: "geojson", data });
      store.map.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": color,
          "line-width": 5,
          "line-opacity": 0.92
        }
      });
    }
  }

  function fitRiderMap(store, rider, customer, options = {}) {
    if (!store || !store.map || !store.maplibregl) return;
    if (options.autoFollow && rider) {
      store.map.easeTo({ center: [rider.lng, rider.lat], zoom: options.followZoom || 16, duration: 450 });
      return;
    }
    if (rider && customer) {
      const bounds = new store.maplibregl.LngLatBounds([rider.lng, rider.lat], [rider.lng, rider.lat]);
      bounds.extend([customer.lng, customer.lat]);
      store.map.fitBounds(bounds, { padding: options.padding || 52, maxZoom: options.maxZoom || 16, duration: 450 });
    } else if (customer) {
      store.map.easeTo({ center: [customer.lng, customer.lat], zoom: options.maxZoom || 16, duration: 450 });
    }
  }

  async function renderRiderRouteMap(options) {
    const customer = normalizeLatLng(options.customer);
    const rider = normalizeLatLng(options.rider);
    const center = rider || customer;
    const messageEl = typeof options.messageEl === "string" ? document.getElementById(options.messageEl) : options.messageEl;
    if (!center || !customer || !window.CBEOlaMapV4) {
      if (messageEl) {
        messageEl.textContent = "Pinned delivery location missing.";
        messageEl.style.display = "flex";
      }
      return null;
    }

    const store = await ensureRiderMap(options.container, center, options);
    if (!store) return null;

    updateMarker(store, "customer", customer, options.customerColor || "#8806CE");
    if (rider) updateMarker(store, "rider", rider, options.riderColor || "#08A045");

    let route = null;
    if (rider) {
      route = await getRoute(rider, customer);
      updateRouteLayer(store, route.coordinates, options.routeColor || "#08A045");
      if (typeof options.onRoute === "function") options.onRoute(route);
    }

    fitRiderMap(store, rider, customer, options);
    setTimeout(() => store.map.resize(), 100);
    if (messageEl) messageEl.style.display = "none";
    return { store, route };
  }

  function openExternalNavigation(destination, origin = null) {
    if (!destination) return;
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination.lat + "," + destination.lng)}&travelmode=driving`;
    if (origin) url += `&origin=${encodeURIComponent(origin.lat + "," + origin.lng)}`;
    window.open(url, "_blank", "noopener");
  }

  function initRiderOrderMaps() {
    const mapCards = Array.from(document.querySelectorAll("[data-rider-map-order]"));
    if (!mapCards.length || !window.CBEOlaMapV4) return;

    mapCards.forEach(container => {
      const order = assignedOrders.find(item => item.id === container.dataset.riderMapOrder);
      const customer = orderPoint(order);
      if (!order || !customer) return;
      const rider = riderPoint(order);
      renderRiderRouteMap({
        container,
        customer,
        rider,
        customerColor: "#8806CE",
        riderColor: "#08A045",
        routeColor: "#08A045",
        padding: 38,
        maxZoom: 16,
        onRoute: route => {
          const meta = document.getElementById(`riderMapMeta-${order.id}`);
          if (meta && rider) meta.textContent = `${route.distanceText || "—"} · ${route.durationText || "—"}`;
        }
      }).catch(error => {
        console.log("Rider preview map V4 failed", error);
        toast("Ola map preview failed. Check Cloudflare function and Ola key.");
      });
    });
  }

  function ensureNavigationModal() {
    let modal = document.getElementById("deliveryNavModal");
    if (modal) return modal;
    modal = document.createElement("section");
    modal.id = "deliveryNavModal";
    modal.className = "delivery-nav-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML = `
      <div class="delivery-nav-sheet">
        <div class="nav-sheet-top">
          <div>
            <div class="nav-kicker">Live delivery route</div>
            <div class="nav-title" id="navCustomerName">Customer</div>
            <div class="nav-subtitle" id="navAddressText">Pinned delivery location</div>
          </div>
          <button class="icon-btn" id="closeNavBtn" type="button" aria-label="Close navigation">×</button>
        </div>
        <div class="nav-map-wrap">
          <div id="riderLiveNavMap" class="nav-live-map"></div>
          <div id="riderLiveNavMsg" class="nav-map-message">Loading live delivery map...</div>
        </div>
        <div class="nav-metrics">
          <div><span>ETA</span><strong id="navEta">—</strong></div>
          <div><span>Distance</span><strong id="navDistance">—</strong></div>
          <div><span>GPS</span><strong id="navGps">Waiting</strong></div>
        </div>
        <div class="nav-actions">
          <button class="btn soft" id="externalNavBtn" type="button">Open maps</button>
          <button class="btn soft" id="stopLiveNavBtn" type="button">Stop live</button>
          <button class="btn brand" id="navDeliveredBtn" type="button">Delivered</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    $("closeNavBtn").addEventListener("click", () => modal.classList.remove("is-open"));
    $("stopLiveNavBtn").addEventListener("click", stopLiveNavigation);
    $("navDeliveredBtn").addEventListener("click", () => {
      if (activeNavigationOrderId) markDelivered(activeNavigationOrderId);
    });
    $("externalNavBtn").addEventListener("click", () => {
      const order = assignedOrders.find(item => item.id === activeNavigationOrderId);
      const destination = orderPoint(order);
      if (destination) openExternalNavigation(destination, latestRiderLocation || riderPoint(order));
    });
    return modal;
  }

  function setNavMetric(id, value) {
    const el = $(id);
    if (el) el.textContent = value || "—";
  }

  async function updateLiveNavigationMap(order, location) {
    if (!order || !window.CBEOlaMapV4) return;
    const customer = orderPoint(order);
    const rider = location || latestRiderLocation || riderPoint(order);
    if (!customer) return toast("This order has no pinned delivery location.");
    await renderRiderRouteMap({
      container: "riderLiveNavMap",
      messageEl: "riderLiveNavMsg",
      customer,
      rider,
      customerColor: "#8806CE",
      riderColor: "#08A045",
      routeColor: "#08A045",
      autoFollow: true,
      followZoom: 16,
      fit: !rider,
      onRoute: route => {
        setNavMetric("navEta", route.durationText);
        setNavMetric("navDistance", route.distanceText);
      }
    });
  }

  async function saveRiderLiveLocation(orderId, location) {
    if (!auth.currentUser || !location) return;
    latestRiderLocation = location;
    lastLiveLocationWriteAt = Date.now();
    setNavMetric("navGps", location.accuracy ? `±${Math.round(Number(location.accuracy))}m` : "Live");

    await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({
      location,
      lat: location.lat,
      lng: location.lng,
      busy: true,
      navigationActive: true,
      locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection("orders").doc(orderId).set({
      status: "out_for_delivery",
      riderLocation: location,
      riderLat: location.lat,
      riderLng: location.lng,
      riderNavigationActive: true,
      riderLocationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedByRiderId: auth.currentUser.uid,
      assignedRiderId: auth.currentUser.uid,
      assignedRiderAuthUid: auth.currentUser.uid,
      assignedRiderPhone: phone10(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderPhoneE164: e164(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderName: riderProfile?.name || "Rider",
      assignedRiderPhotoUrl: riderProfile?.photoUrl || riderProfile?.photoURL || riderProfile?.profilePhotoUrl || riderProfile?.imageUrl || ""
    }, { merge: true });
  }

  function startLocationWatch(order) {
    if (!navigator.geolocation || !auth.currentUser || !order) return;
    if (liveWatchId !== null) navigator.geolocation.clearWatch(liveWatchId);
    liveWatchId = navigator.geolocation.watchPosition(async position => {
      const location = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy || "",
        heading: position.coords.heading || "",
        speed: position.coords.speed || "",
        updatedAtClient: new Date().toISOString()
      };
      latestRiderLocation = location;
      const now = Date.now();
      if (now - lastLiveLocationWriteAt < LIVE_LOCATION_SYNC_MIN_MS) return;
      await saveRiderLiveLocation(order.id, location);
      updateLiveNavigationMap(order, location).catch(() => {});
    }, error => {
      console.log("Live GPS watch error", error);
      toast("Keep GPS permission on for live tracking.");
      setNavMetric("navGps", "GPS blocked");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  }

  async function startDeliveryNavigation(orderId) {
    const order = assignedOrders.find(item => item.id === orderId);
    if (!order) return toast("Order not found.");
    const destination = orderPoint(order);
    if (!destination) return toast("Customer pinned location missing.");

    activeNavigationOrderId = orderId;
    const modal = ensureNavigationModal();
    $("navCustomerName").textContent = orderCustomerName(order);
    $("navAddressText").textContent = orderAddress(order) || "Pinned delivery location";
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");

    let location = await getCurrentPositionSafe(true);
    if (location) {
      latestRiderLocation = location;
      if (Date.now() - lastLiveLocationWriteAt >= LIVE_LOCATION_SYNC_MIN_MS) {
        await saveRiderLiveLocation(orderId, location);
      }
    }

    await updateLiveNavigationMap(order, location || riderPoint(order));
    startLocationWatch(order);
    toast("Live tracking started. Keep this screen open while delivering.");
  }

  async function stopLiveNavigation() {
    if (liveWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(liveWatchId);
      liveWatchId = null;
    }
    if (auth.currentUser) {
      await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({
        navigationActive: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (activeNavigationOrderId) {
        await db.collection("orders").doc(activeNavigationOrderId).set({
          riderNavigationActive: false,
          riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
    setNavMetric("navGps", "Stopped");
    toast("Live navigation stopped.");
  }

  function toast(message) {
    const el = $("toast");
    if (!el || !message) return;
    el.textContent = message;
    el.style.display = "block";
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => { el.style.display = "none"; }, 2400);
  }

  function playAlertSound() {
    if (!soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.setValueAtTime(980, ctx.currentTime + 0.10);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.34);
    } catch (_) {}
  }

  function showLoginStep(step) {
    $("phoneScreen").hidden = step !== "phone";
    $("otpScreen").hidden = step !== "otp";
    $("nameScreen").hidden = step !== "name";
  }

  function setButtonLoading(btn, loadingText, isLoading) {
    if (!btn) return;
    if (isLoading) {
      btn.dataset.defaultText = btn.textContent;
      btn.textContent = loadingText;
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.defaultText || btn.textContent;
      btn.disabled = false;
    }
  }

  function setupRecaptcha() {
    if (recaptchaVerifier) return recaptchaVerifier;
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier("recaptcha-container", {
      size: "invisible",
      callback: function () {}
    });
    return recaptchaVerifier;
  }

  async function sendOtp() {
    const phone = phone10($("phoneInput").value);
    if (phone.length !== 10) return toast("Enter a valid 10-digit mobile number.");
    const btn = $("sendOtpBtn");
    setButtonLoading(btn, "Sending...", true);
    try {
      confirmationResult = await auth.signInWithPhoneNumber(`+91${phone}`, setupRecaptcha());
      localStorage.setItem("rider_phone_pending", phone);
      showLoginStep("otp");
      toast("OTP sent.");
    } catch (error) {
      toast(error.message || "OTP failed. Check Firebase Phone Auth setup.");
      try { recaptchaVerifier?.clear(); } catch (_) {}
      recaptchaVerifier = null;
    } finally {
      setButtonLoading(btn, "", false);
    }
  }

  async function verifyOtp() {
    const code = clean($("otpInput").value);
    if (!confirmationResult) return toast("Send OTP first.");
    if (code.length !== 6) return toast("Enter 6-digit OTP.");
    const btn = $("verifyOtpBtn");
    setButtonLoading(btn, "Verifying...", true);
    try {
      await confirmationResult.confirm(code);
    } catch (error) {
      toast(error.message || "OTP verification failed.");
    } finally {
      setButtonLoading(btn, "", false);
    }
  }

  function unsubscribeAll() {
    riderUnsubs.forEach(unsub => {
      try { unsub(); } catch (_) {}
    });
    riderUnsubs = [];
  }

  async function loadOrCreateRider(user) {
    const ref = db.collection("deliveryPartners").doc(user.uid);
    const snap = await ref.get();
    const phone = phone10(user.phoneNumber || localStorage.getItem("rider_phone_pending"));
    const base = {
      authUid: user.uid,
      phone,
      phoneE164: user.phoneNumber || e164(phone),
      active: true,
      online: true,
      busy: false,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (!snap.exists) {
      await ref.set({
        ...base,
        name: "",
        vehicle: "",
        vehicleNumber: "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      riderProfile = { id: user.uid, ...base, name: "" };
      return riderProfile;
    }

    await ref.set(base, { merge: true });
    riderProfile = { id: user.uid, ...snap.data(), ...base };
    return riderProfile;
  }

  function applyRiderProfile(profile) {
    const name = clean(profile?.name || "");
    const phone = phone10(profile?.phone || profile?.phoneE164 || auth.currentUser?.phoneNumber);
    $("riderNameText").textContent = name || "Rider";
    $("riderPhoneText").textContent = phone ? `+91 ${phone}` : "Verified mobile";
    $("riderInitial").textContent = (name || "R").slice(0, 1).toUpperCase();
    $("profileName").value = name;
    $("profilePhone").value = phone ? `+91 ${phone}` : "";
    $("profileVehicle").value = profile?.vehicle || "";
    $("profileVehicleNo").value = profile?.vehicleNumber || "";
    $("onlineToggle").checked = profile?.online !== false;
    renderOnlineText();
  }

  async function saveRiderName() {
    const name = clean($("riderNameInput").value);
    if (name.length < 2) return toast("Enter rider name.");
    const user = auth.currentUser;
    if (!user) return;
    await db.collection("deliveryPartners").doc(user.uid).set({
      name,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    riderProfile = { ...(riderProfile || {}), id: user.uid, name };
    bootRider(user);
  }

  async function saveProfile() {
    const user = auth.currentUser;
    if (!user) return;
    const name = clean($("profileName").value);
    if (name.length < 2) return toast("Enter rider name.");
    await db.collection("deliveryPartners").doc(user.uid).set({
      name,
      vehicle: clean($("profileVehicle").value),
      vehicleNumber: clean($("profileVehicleNo").value).toUpperCase(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    toast("Profile saved.");
  }

  function renderOnlineText() {
    const online = $("onlineToggle").checked;
    $("onlineTitle").textContent = online ? "You are available" : "You are offline";
    $("onlineSubtext").textContent = online ? "Ready to receive assigned deliveries." : "Admin can still see you, but you are marked offline.";
  }

  async function setOnlineStatus() {
    const user = auth.currentUser;
    if (!user) return;
    renderOnlineText();
    await db.collection("deliveryPartners").doc(user.uid).set({
      online: $("onlineToggle").checked,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  function bootRider(user) {
    $("loginCard").hidden = true;
    $("riderPanel").hidden = false;
    $("connectionText").textContent = "Connected to Firebase";
    listenRiderProfile(user.uid);
    listenAssignedOrders(user.uid);
  }

  function listenRiderProfile(uid) {
    const unsub = db.collection("deliveryPartners").doc(uid).onSnapshot(snapshot => {
      riderProfile = { id: uid, ...(snapshot.data() || {}) };
      applyRiderProfile(riderProfile);
    }, error => toast(error.message || "Rider profile sync failed."));
    riderUnsubs.push(unsub);
  }

  function listenAssignedOrders(uid) {
    const riderPhone = phone10(auth.currentUser?.phoneNumber || riderProfile?.phone || localStorage.getItem("rider_phone_pending"));
    const byUid = new Map();
    const byPhone = new Map();

    function rebuildAssignedOrders() {
      const merged = new Map();
      byPhone.forEach((value, key) => merged.set(key, value));
      byUid.forEach((value, key) => merged.set(key, value));

      assignedOrders = Array.from(merged.values()).sort((a, b) => {
        return toDate(b.createdAt || b.createdAtClient) - toDate(a.createdAt || a.createdAtClient);
      });

      const active = assignedOrders.filter(order => !["delivered", "cancelled", "payment_failed"].includes(order.status));
      const ids = new Set(active.map(order => order.id));
      if (bootedOrdersOnce) {
        const newOrders = active.filter(order => !lastAssignedIds.has(order.id));
        if (newOrders.length) {
          playAlertSound();
          toast(`New delivery assigned: #${String(newOrders[0].id).slice(-6)}`);
        }
      }
      lastAssignedIds = ids;
      bootedOrdersOnce = true;
      renderOrders();
    }

    function consumeSnapshot(targetMap) {
      return snapshot => {
        targetMap.clear();
        snapshot.docs.forEach(doc => targetMap.set(doc.id, { id: doc.id, ...doc.data() }));
        rebuildAssignedOrders();
      };
    }

    const unsubByUid = db.collection("orders")
      .where("assignedRiderId", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(80)
      .onSnapshot(consumeSnapshot(byUid), error => {
        toast(error.message || "Assigned orders sync failed. Check Firestore index/rules.");
      });
    riderUnsubs.push(unsubByUid);

    if (riderPhone) {
      const unsubByPhone = db.collection("orders")
        .where("assignedRiderPhone", "==", riderPhone)
        .orderBy("createdAt", "desc")
        .limit(80)
        .onSnapshot(consumeSnapshot(byPhone), error => {
          toast(error.message || "Assigned orders phone sync failed. Check Firestore index/rules.");
        });
      riderUnsubs.push(unsubByPhone);
    }
  }

  function renderOrders() {
    const active = assignedOrders.filter(order => !["delivered", "cancelled", "payment_failed"].includes(order.status));
    const delivered = assignedOrders.filter(order => order.status === "delivered");
    const deliveredToday = delivered.filter(order => isToday(order.deliveredAt || order.updatedAt || order.createdAt));
    const onWay = assignedOrders.filter(order => order.status === "out_for_delivery");

    $("statAssigned").textContent = active.length;
    $("statOnWay").textContent = onWay.length;
    $("statDelivered").textContent = deliveredToday.length;
    $("statValue").textContent = money(deliveredToday.reduce((sum, order) => sum + orderTotal(order), 0));

    $("activeOrdersList").innerHTML = active.length
      ? active.map(renderOrderCard).join("")
      : `<div class="empty-card">No active assigned orders. Ask admin to assign an order to you.</div>`;

    $("deliveredOrdersList").innerHTML = delivered.length
      ? delivered.map(renderOrderCard).join("")
      : `<div class="empty-card">No delivered orders yet.</div>`;

    document.querySelectorAll("[data-pickup]").forEach(btn => {
      btn.addEventListener("click", () => markPickedUp(btn.dataset.pickup));
    });
    document.querySelectorAll("[data-delivered]").forEach(btn => {
      btn.addEventListener("click", () => markDelivered(btn.dataset.delivered));
    });
    document.querySelectorAll("[data-navigate]").forEach(btn => {
      btn.addEventListener("click", () => startDeliveryNavigation(btn.dataset.navigate));
    });
    setTimeout(initRiderOrderMaps, 80);
  }

  function renderOrderCard(order) {
    const id = escapeHTML(order.id);
    const status = clean(order.status || "confirmed");
    const created = toDate(order.createdAt || order.createdAtClient).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    const phone = orderCustomerPhone(order);
    const address = orderAddress(order);
    const items = Array.isArray(order.items) && order.items.length
      ? order.items.map(item => `${Number(item.qty || 1)}× ${escapeHTML(item.name || "Item")}`).join("<br>")
      : "—";
    const pickupButton = ["confirmed", "preparing"].includes(status)
      ? `<button class="btn brand small" data-pickup="${id}" type="button">Picked up</button>`
      : "";
    const deliveredButton = status === "out_for_delivery"
      ? `<button class="btn brand small" data-delivered="${id}" type="button">Delivered</button>`
      : "";
    const destination = orderPoint(order);
    const navigationButton = destination ? `<button class="btn soft small" data-navigate="${id}" type="button">Navigate</button>` : "";
    const whatsAppPhone = phone10(phone);
    const waUrl = whatsAppPhone ? `https://wa.me/91${whatsAppPhone}?text=${encodeURIComponent("Hi, I am from CBE Foods. I am on the way with your order.")}` : "#";

    return `<article class="order-card">
      <div class="order-top">
        <div>
          <div class="order-id">#${escapeHTML(String(order.id).slice(-6))}</div>
          <div class="muted">${escapeHTML(created)}</div>
        </div>
        <div class="price">${money(orderTotal(order))}</div>
      </div>
      <div class="status-pill ${escapeHTML(status)}">${escapeHTML(statusLabel(status))}</div>
      <div class="row"><span>Customer</span><strong>${escapeHTML(orderCustomerName(order))}<br>${escapeHTML(phone || "—")}</strong></div>
      <div class="row"><span>Address</span><strong>${escapeHTML(address || "—")}</strong></div>
      ${orderPoint(order) ? `<div class="rider-order-map" id="riderMap-${id}" data-rider-map-order="${id}" aria-label="Ola Maps rider delivery map"></div><div class="map-note">Purple pin: customer exact pinned location. Green pin: your latest GPS. <span id="riderMapMeta-${id}">Tap Navigate for live route.</span></div>` : ""}
      <div class="item-list">${items}</div>
      <div class="row"><span>Payment</span><strong>${escapeHTML(order.paymentStatus || "—")} · ${escapeHTML(order.paymentProvider || "Razorpay")}</strong></div>
      <div class="actions-grid four">
        <a class="btn soft small" href="tel:${escapeHTML(phone)}">Call</a>
        ${navigationButton || `<a class="btn soft small" target="_blank" rel="noopener" href="${waUrl}">WhatsApp</a>`}
        ${pickupButton || deliveredButton || `<a class="btn soft small" target="_blank" rel="noopener" href="${waUrl}">WhatsApp</a>`}
        <button class="btn soft small" data-navigate="${id}" type="button">Live map</button>
      </div>
    </article>`;
  }

  async function markPickedUp(orderId) {
    if (!orderId) return;
    const location = await getCurrentPositionSafe(false);
    const patch = {
      status: "out_for_delivery",
      riderNavigationActive: true,
      pickedUpAt: firebase.firestore.FieldValue.serverTimestamp(),
      riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedByRiderId: auth.currentUser.uid,
      assignedRiderId: auth.currentUser.uid,
      assignedRiderAuthUid: auth.currentUser.uid,
      assignedRiderPhone: phone10(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderPhoneE164: e164(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderName: riderProfile?.name || "Rider",
      assignedRiderPhotoUrl: riderProfile?.photoUrl || riderProfile?.photoURL || riderProfile?.profilePhotoUrl || riderProfile?.imageUrl || "",
      deliveryEvents: firebase.firestore.FieldValue.arrayUnion({
        status: "out_for_delivery",
        label: "Picked up by rider",
        atClient: new Date().toISOString(),
        riderId: auth.currentUser.uid
      })
    };
    if (location) {
      latestRiderLocation = location;
      lastLiveLocationWriteAt = Date.now();
      patch.riderLocation = location;
      patch.riderLat = location.lat;
      patch.riderLng = location.lng;
      patch.riderLocationUpdatedAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    await db.collection("orders").doc(orderId).set(patch, { merge: true });
    await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({ busy: true, navigationActive: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    toast("Order marked on the way.");
    startDeliveryNavigation(orderId);
  }

  async function markDelivered(orderId) {
    if (!orderId) return;
    if (!confirm("Mark this order as delivered?")) return;
    const location = await getCurrentPositionSafe(false);
    const patch = {
      status: "delivered",
      riderNavigationActive: false,
      deliveredAt: firebase.firestore.FieldValue.serverTimestamp(),
      riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedByRiderId: auth.currentUser.uid,
      assignedRiderId: auth.currentUser.uid,
      assignedRiderAuthUid: auth.currentUser.uid,
      assignedRiderPhone: phone10(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderPhoneE164: e164(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderName: riderProfile?.name || "Rider",
      assignedRiderPhotoUrl: riderProfile?.photoUrl || riderProfile?.photoURL || riderProfile?.profilePhotoUrl || riderProfile?.imageUrl || "",
      deliveryEvents: firebase.firestore.FieldValue.arrayUnion({
        status: "delivered",
        label: "Delivered by rider",
        atClient: new Date().toISOString(),
        riderId: auth.currentUser.uid
      })
    };
    if (location) {
      patch.riderLocation = location;
      patch.riderLat = location.lat;
      patch.riderLng = location.lng;
    }
    await db.collection("orders").doc(orderId).set(patch, { merge: true });
    const stillActive = assignedOrders.filter(order => order.id !== orderId && !["delivered", "cancelled", "payment_failed"].includes(order.status));
    await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({
      busy: stillActive.length > 0,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (activeNavigationOrderId === orderId) {
      await stopLiveNavigation();
      const modal = document.getElementById("deliveryNavModal");
      if (modal) modal.classList.remove("is-open");
    }
    toast("Order delivered.");
  }

  function getCurrentPositionSafe(showToast = true) {
    return new Promise(resolve => {
      if (!navigator.geolocation) {
        if (showToast) toast("GPS is not supported on this device.");
        return resolve(null);
      }
      navigator.geolocation.getCurrentPosition(position => {
        resolve({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy || "",
          updatedAtClient: new Date().toISOString()
        });
      }, () => {
        if (showToast) toast("GPS permission denied or unavailable.");
        resolve(null);
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
    });
  }

  async function updateGPS() {
    const location = await getCurrentPositionSafe(true);
    if (!location || !auth.currentUser) return;
    await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({
      location,
      lat: location.lat,
      lng: location.lng,
      locationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const outForDelivery = assignedOrders.filter(order => order.status === "out_for_delivery");
    await Promise.all(outForDelivery.map(order => db.collection("orders").doc(order.id).set({
      riderLocation: location,
      riderLat: location.lat,
      riderLng: location.lng,
      riderLocationUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true })));
    riderMaps.clear();
    renderOrders();
    toast("GPS updated.");
  }

  function setupTabs() {
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(item => item.classList.remove("active"));
        tab.classList.add("active");
        document.querySelectorAll(".tab-section").forEach(section => section.classList.remove("active"));
        $(`${tab.dataset.tab}Section`).classList.add("active");
      });
    });
  }

  function setupActions() {
    $("refreshBtn").addEventListener("click", () => window.location.reload());
    $("sendOtpBtn").addEventListener("click", sendOtp);
    $("verifyOtpBtn").addEventListener("click", verifyOtp);
    $("backToPhoneBtn").addEventListener("click", () => showLoginStep("phone"));
    $("saveNameBtn").addEventListener("click", saveRiderName);
    $("logoutBtn").addEventListener("click", () => auth.signOut());
    $("onlineToggle").addEventListener("change", setOnlineStatus);
    $("locationBtn").addEventListener("click", updateGPS);
    $("saveProfileBtn").addEventListener("click", saveProfile);
    $("testSoundBtn").addEventListener("click", () => { playAlertSound(); toast("Alert sound tested."); });
    $("phoneInput").addEventListener("input", () => { $("phoneInput").value = phone10($("phoneInput").value); });
    $("otpInput").addEventListener("keydown", event => { if (event.key === "Enter") verifyOtp(); });
  }

  function setupAuth() {
    auth.onAuthStateChanged(async user => {
      unsubscribeAll();
      if (!user) {
        riderProfile = null;
        assignedOrders = [];
        $("loginCard").hidden = false;
        $("riderPanel").hidden = true;
        $("connectionText").textContent = "Firebase delivery control";
        showLoginStep("phone");
        return;
      }
      const profile = await loadOrCreateRider(user);
      if (!clean(profile.name)) {
        $("loginCard").hidden = false;
        $("riderPanel").hidden = true;
        $("connectionText").textContent = "Complete rider profile";
        showLoginStep("name");
        return;
      }
      bootRider(user);
    });
  }

  function boot() {
    if (!initFirebase()) return;
    setupActions();
    setupTabs();
    setupAuth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
