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
    return normalizeLatLng(order.deliveryLocation) || normalizeLatLng(order.location) || null;
  }

  function riderPoint(order) {
    return normalizeLatLng(order.riderLocation || { lat: order.riderLat, lng: order.riderLng }) || normalizeLatLng(riderProfile?.location || { lat: riderProfile?.lat, lng: riderProfile?.lng });
  }

  function getOlaStyleUrl() {
    return `${OLA_PROXY_URL}?type=style&style=default-light-standard`;
  }

  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (mapLibreLoadingPromise) return mapLibreLoadingPromise;
    mapLibreLoadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.js";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve(window.maplibregl);
      script.onerror = () => reject(new Error("MapLibre failed to load"));
      document.head.appendChild(script);
    });
    return mapLibreLoadingPromise;
  }

  function initRiderOrderMaps() {
    const mapCards = Array.from(document.querySelectorAll("[data-rider-map-order]"));
    if (!mapCards.length) return;
    loadMapLibre().then(maplibregl => {
      mapCards.forEach(container => {
        const order = assignedOrders.find(item => item.id === container.dataset.riderMapOrder);
        const customer = orderPoint(order);
        if (!order || !customer || riderMaps.has(container.id)) return;
        const map = new maplibregl.Map({
          container,
          style: getOlaStyleUrl(),
          center: [customer.lng, customer.lat],
          zoom: 15,
          attributionControl: false
        });
        riderMaps.set(container.id, map);
        map.on("load", () => {
          new maplibregl.Marker({ color: "#8806CE" }).setLngLat([customer.lng, customer.lat]).addTo(map);
          const rider = riderPoint(order);
          if (rider) {
            new maplibregl.Marker({ color: "#08A045" }).setLngLat([rider.lng, rider.lat]).addTo(map);
            map.addSource(`route-${order.id}`, { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [[rider.lng, rider.lat], [customer.lng, customer.lat]] }, properties: {} } });
            map.addLayer({ id: `route-${order.id}`, type: "line", source: `route-${order.id}`, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#08A045", "line-width": 4, "line-opacity": 0.9 } });
            const bounds = new maplibregl.LngLatBounds();
            bounds.extend([customer.lng, customer.lat]);
            bounds.extend([rider.lng, rider.lat]);
            map.fitBounds(bounds, { padding: 38, maxZoom: 15, duration: 400 });
          }
        });
      });
    }).catch(() => toast("Ola map preview failed. Check Netlify function and OLA_MAPS_API_KEY."));
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
    const mapsUrl = destination ? `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
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
      ${orderPoint(order) ? `<div class="rider-order-map" id="riderMap-${id}" data-rider-map-order="${id}" aria-label="Ola Maps rider delivery map"></div><div class="map-note">Purple pin: customer exact pinned location. Green pin: your latest GPS.</div>` : ""}
      <div class="item-list">${items}</div>
      <div class="row"><span>Payment</span><strong>${escapeHTML(order.paymentStatus || "—")} · ${escapeHTML(order.paymentProvider || "Razorpay")}</strong></div>
      <div class="actions-grid ${pickupButton || deliveredButton ? "three" : ""}">
        <a class="btn soft small" href="tel:${escapeHTML(phone)}">Call</a>
        <a class="btn soft small" target="_blank" rel="noopener" href="${mapsUrl}">Map</a>
        ${pickupButton || deliveredButton || `<a class="btn soft small" target="_blank" rel="noopener" href="${waUrl}">WhatsApp</a>`}
      </div>
    </article>`;
  }

  async function markPickedUp(orderId) {
    if (!orderId) return;
    const location = await getCurrentPositionSafe(false);
    const patch = {
      status: "out_for_delivery",
      pickedUpAt: firebase.firestore.FieldValue.serverTimestamp(),
      riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedByRiderId: auth.currentUser.uid,
      assignedRiderId: auth.currentUser.uid,
      assignedRiderAuthUid: auth.currentUser.uid,
      assignedRiderPhone: phone10(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderPhoneE164: e164(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderName: riderProfile?.name || "Rider",
      deliveryEvents: firebase.firestore.FieldValue.arrayUnion({
        status: "out_for_delivery",
        label: "Picked up by rider",
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
    await db.collection("deliveryPartners").doc(auth.currentUser.uid).set({ busy: true, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    toast("Order marked on the way.");
  }

  async function markDelivered(orderId) {
    if (!orderId) return;
    if (!confirm("Mark this order as delivered?")) return;
    const location = await getCurrentPositionSafe(false);
    const patch = {
      status: "delivered",
      deliveredAt: firebase.firestore.FieldValue.serverTimestamp(),
      riderUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedByRiderId: auth.currentUser.uid,
      assignedRiderId: auth.currentUser.uid,
      assignedRiderAuthUid: auth.currentUser.uid,
      assignedRiderPhone: phone10(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderPhoneE164: e164(auth.currentUser.phoneNumber || riderProfile?.phone || ""),
      assignedRiderName: riderProfile?.name || "Rider",
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
