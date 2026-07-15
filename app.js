const DEFAULT_CENTER = [35.1815, 136.9066];
const LEGACY_STORAGE_KEY = "radius-note-map.places.v1";
const API_URL = window.RADIUS_NOTE_MAP_CONFIG?.functionUrl?.replace(/\/$/, "") || "";

const map = L.map("map", { zoomControl: false }).setView(DEFAULT_CENTER, 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const elements = {
  name: document.querySelector("#name-input"),
  showName: document.querySelector("#show-name-input"),
  radius: document.querySelector("#radius-input"),
  memo: document.querySelector("#memo-input"),
  coordinates: document.querySelector("#coordinates"),
  status: document.querySelector("#editor-status"),
  save: document.querySelector("#save-button"),
  cancel: document.querySelector("#cancel-button"),
  list: document.querySelector("#place-list"),
  count: document.querySelector("#place-count"),
  clear: document.querySelector("#clear-button"),
  guide: document.querySelector("#map-guide"),
  editor: document.querySelector("#editor-panel"),
  modeBadge: document.querySelector("#mode-badge"),
  modeButton: document.querySelector("#mode-button"),
  connection: document.querySelector("#connection-message"),
  authDialog: document.querySelector("#auth-dialog"),
  authForm: document.querySelector("#auth-form"),
  password: document.querySelector("#password-input"),
  authError: document.querySelector("#auth-error"),
  loginButton: document.querySelector("#login-button"),
  passwordPanel: document.querySelector("#password-panel"),
  newPassword: document.querySelector("#new-password-input"),
  changePassword: document.querySelector("#change-password-button"),
  passwordMessage: document.querySelector("#password-message")
};

const state = {
  places: [],
  adminToken: null,
  draft: null,
  editingId: null,
  previewMarker: null,
  previewCircle: null,
  layers: new Map(),
  labelLayoutFrame: null
};

map.on("click", ({ latlng }) => {
  if (isAdmin()) beginNewPlace(latlng);
});
map.on("zoomend moveend resize", scheduleLabelLayout);
elements.radius.addEventListener("input", updatePreviewRadius);
elements.save.addEventListener("click", savePlace);
elements.cancel.addEventListener("click", resetEditor);
elements.clear.addEventListener("click", clearAllPlaces);
elements.modeButton.addEventListener("click", toggleMode);
elements.authForm.addEventListener("submit", authenticate);
elements.changePassword.addEventListener("click", changePassword);

main();

async function main() {
  renderMode();
  if (!API_URL) {
    showConnectionMessage("Supabaseの接続先が未設定です。config.js にEdge FunctionのURLを設定してください。");
    renderList();
    return;
  }
  await reloadPlaces(true);
}

function isAdmin() {
  return Boolean(state.adminToken);
}

function toggleMode() {
  if (isAdmin()) {
    leaveAdminMode();
    return;
  }
  elements.authError.textContent = "";
  elements.password.value = "";
  elements.authDialog.showModal();
  elements.password.focus();
}

async function authenticate(event) {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    elements.authDialog.close();
    return;
  }
  const password = elements.password.value;
  if (!password) return;
  elements.loginButton.disabled = true;
  elements.authError.textContent = "";
  try {
    const result = await apiRequest("login", { password });
    state.adminToken = result.token;
    elements.password.value = "";
    elements.authDialog.close();
    renderMode();
    renderPlaces();
    renderList();
    await migrateLegacyPlaces();
  } catch (error) {
    elements.authError.textContent = error.message;
  } finally {
    elements.loginButton.disabled = false;
  }
}

function leaveAdminMode() {
  state.adminToken = null;
  resetEditor();
  renderMode();
  renderPlaces();
  renderList();
}

function renderMode() {
  const admin = isAdmin();
  elements.modeBadge.textContent = admin ? "地点登録モード" : "閲覧モード";
  elements.modeBadge.classList.toggle("admin", admin);
  elements.modeButton.textContent = admin ? "閲覧モードへ" : "地点登録モードへ";
  elements.editor.hidden = !admin;
  elements.passwordPanel.hidden = !admin;
  elements.guide.textContent = admin ? "地図上の登録したい場所をクリック" : "閲覧モード：地点をクリックして内容を確認";
}

function beginNewPlace(latlng) {
  state.editingId = null;
  state.draft = { lat: latlng.lat, lng: latlng.lng };
  elements.name.value = "";
  elements.showName.checked = true;
  elements.memo.value = "";
  elements.radius.value = "500";
  showDraft("新規地点");
}

function editPlace(id) {
  if (!isAdmin()) return;
  const place = state.places.find((item) => item.id === id);
  if (!place) return;
  state.editingId = id;
  state.draft = { lat: place.lat, lng: place.lng };
  elements.name.value = place.name;
  elements.showName.checked = showsName(place);
  elements.memo.value = place.memo;
  elements.radius.value = String(place.radius);
  showDraft("編集中");
  map.setView([place.lat, place.lng], Math.max(map.getZoom(), 15), { animate: true });
  renderPlaces();
  renderList();
}

function showDraft(status) {
  clearPreview();
  const latlng = [state.draft.lat, state.draft.lng];
  state.previewCircle = L.circle(latlng, circleStyle(normalizedRadius())).addTo(map);
  state.previewMarker = L.marker(latlng, { icon: pointIcon(true) }).addTo(map);
  elements.coordinates.textContent = `${state.draft.lat.toFixed(6)}, ${state.draft.lng.toFixed(6)}`;
  elements.status.textContent = status;
  elements.save.textContent = state.editingId ? "変更を保存" : "この地点を登録";
  elements.save.disabled = false;
  elements.cancel.disabled = false;
  elements.guide.textContent = "半径とメモを入力して保存";
  elements.name.focus();
}

function updatePreviewRadius() {
  if (state.previewCircle) state.previewCircle.setRadius(normalizedRadius());
}

async function savePlace() {
  if (!state.draft || !isAdmin()) return;
  const payload = {
    id: state.editingId || undefined,
    lat: state.draft.lat,
    lng: state.draft.lng,
    name: elements.name.value.trim() || `地点 ${state.places.length + 1}`,
    showName: elements.showName.checked,
    radius: normalizedRadius(),
    memo: elements.memo.value.trim()
  };
  elements.save.disabled = true;
  try {
    const result = await apiRequest(state.editingId ? "update" : "create", { place: payload }, true);
    resetEditor();
    await reloadPlaces();
    focusPlace(result.place.id);
  } catch (error) {
    handleApiError(error);
  } finally {
    if (state.draft) elements.save.disabled = false;
  }
}

function resetEditor() {
  state.draft = null;
  state.editingId = null;
  clearPreview();
  elements.name.value = "";
  elements.showName.checked = true;
  elements.memo.value = "";
  elements.radius.value = "500";
  elements.coordinates.textContent = "緯度・経度は未選択です";
  elements.status.textContent = "地図をクリック";
  elements.save.textContent = "この地点を登録";
  elements.save.disabled = true;
  elements.cancel.disabled = true;
  renderMode();
}

async function reloadPlaces(fit = false) {
  try {
    const result = await apiRequest("list");
    state.places = result.places;
    hideConnectionMessage();
    renderPlaces();
    renderList();
    if (fit) fitSavedPlaces();
  } catch (error) {
    showConnectionMessage(`地点データを読み込めませんでした。${error.message}`);
    renderList();
  }
}

async function migrateLegacyPlaces() {
  let legacyPlaces;
  try {
    legacyPlaces = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
  } catch {
    return;
  }
  if (!Array.isArray(legacyPlaces) || !legacyPlaces.length) return;
  if (!confirm(`このブラウザに保存されている${legacyPlaces.length}件の地点をサーバーへ移行しますか？`)) return;
  try {
    for (const place of legacyPlaces) {
      await apiRequest("create", {
        place: {
          lat: Number(place.lat),
          lng: Number(place.lng),
          name: String(place.name || "移行地点").slice(0, 60),
          showName: place.showName !== false,
          radius: Math.min(50000, Math.max(10, Math.round(Number(place.radius) || 500))),
          memo: String(place.memo || "").slice(0, 200)
        }
      }, true);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    await reloadPlaces(true);
  } catch (error) {
    showConnectionMessage(`ブラウザ保存データの移行に失敗しました。${error.message}`);
  }
}

function renderPlaces() {
  for (const { marker, circle, permanentLabel, connector } of state.layers.values()) {
    marker.remove();
    circle.remove();
    permanentLabel?.remove();
    connector?.remove();
  }
  state.layers.clear();
  for (const place of state.places) {
    const selected = place.id === state.editingId;
    const circle = L.circle([place.lat, place.lng], circleStyle(place.radius)).addTo(map);
    const marker = L.marker([place.lat, place.lng], { icon: pointIcon(selected), title: place.name }).addTo(map);
    const showName = showsName(place);
    const permanent = showName || Boolean(place.memo);
    const nameText = showName || !place.memo ? `<strong>${escapeHtml(place.name)}</strong>` : "";
    const separator = nameText && place.memo ? "<br>" : "";
    const label = `<div class="note-card">${nameText}${separator}${escapeHtml(place.memo)}</div>`;
    let permanentLabel = null;
    let connector = null;
    if (permanent) {
      permanentLabel = L.tooltip({ permanent: true, direction: "center", className: "note-label", interactive: false })
        .setLatLng([place.lat, place.lng])
        .setContent(label)
        .addTo(map);
      connector = L.polyline([[place.lat, place.lng], [place.lat, place.lng]], {
        color: "#7b918b",
        weight: 1,
        opacity: 0,
        interactive: false
      }).addTo(map);
    } else {
      marker.bindTooltip(label, { direction: "right", offset: [13, 0], className: "note-label" });
    }
    marker.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      if (isAdmin()) editPlace(place.id);
      else focusPlace(place.id);
    });
    state.layers.set(place.id, { marker, circle, permanentLabel, connector, place });
  }
  scheduleLabelLayout();
}

function scheduleLabelLayout() {
  if (state.labelLayoutFrame) cancelAnimationFrame(state.labelLayoutFrame);
  state.labelLayoutFrame = requestAnimationFrame(() => {
    state.labelLayoutFrame = null;
    layoutPermanentLabels();
  });
}

function layoutPermanentLabels() {
  const mapSize = map.getSize();
  const mapBounds = map.getBounds();
  const entries = [...state.layers.values()]
    .filter(({ permanentLabel }) => permanentLabel?.getElement())
    .sort((left, right) => left.place.lat - right.place.lat || left.place.lng - right.place.lng);
  const occupied = [...state.layers.values()]
    .map(({ place, circle }) => {
      const point = map.latLngToContainerPoint([place.lat, place.lng]);
      const visible = mapBounds.intersects(circle.getBounds())
        && point.x >= 0 && point.x <= mapSize.x && point.y >= 0 && point.y <= mapSize.y;
      return visible ? labelRectangle(point.x, point.y, 28, 28) : null;
    })
    .filter(Boolean);

  for (const { place, circle, permanentLabel, connector } of entries) {
    const element = permanentLabel.getElement();
    const anchor = map.latLngToContainerPoint([place.lat, place.lng]);
    const circleVisible = mapBounds.intersects(circle.getBounds());
    const pointVisible = anchor.x >= 0 && anchor.x <= mapSize.x && anchor.y >= 0 && anchor.y <= mapSize.y;

    if (!circleVisible || !pointVisible) {
      element.style.display = "none";
      connector.setStyle({ opacity: 0 });
      continue;
    }

    element.style.display = "";
    const width = Math.max(60, element.offsetWidth);
    const height = Math.max(28, element.offsetHeight);
    const selected = nearestAvailableLabelPosition(anchor, width, height, mapSize, occupied);

    if (!selected) {
      element.style.display = "none";
      connector.setStyle({ opacity: 0 });
      continue;
    }

    element.style.display = "";
    occupied.push(selected.rectangle);
    const labelLatLng = map.containerPointToLatLng([selected.centerX, selected.centerY]);
    permanentLabel.setLatLng(labelLatLng);
    connector.setLatLngs([[place.lat, place.lng], labelLatLng]);
    const distance = Math.hypot(selected.centerX - anchor.x, selected.centerY - anchor.y);
    connector.setStyle({ opacity: distance > 28 ? 0.55 : 0 });
  }
}

function nearestAvailableLabelPosition(anchor, width, height, mapSize, occupied) {
  const padding = 8;
  const step = 6;
  const minimumX = width / 2 + padding;
  const maximumX = mapSize.x - width / 2 - padding;
  const minimumY = height / 2 + padding;
  const maximumY = mapSize.y - height / 2 - padding;
  const candidates = [];

  for (let centerY = minimumY; centerY <= maximumY; centerY += step) {
    for (let centerX = minimumX; centerX <= maximumX; centerX += step) {
      candidates.push({
        centerX,
        centerY,
        distanceSquared: (centerX - anchor.x) ** 2 + (centerY - anchor.y) ** 2
      });
    }
  }

  candidates.sort((left, right) => left.distanceSquared - right.distanceSquared);
  for (const candidate of candidates) {
    const rectangle = labelRectangle(candidate.centerX, candidate.centerY, width, height);
    if (!occupied.some((other) => rectanglesOverlap(rectangle, other, 7))) {
      return { ...candidate, rectangle };
    }
  }
  return null;
}

function rectanglesOverlap(left, right, padding) {
  return !(left.right + padding <= right.left
    || left.left >= right.right + padding
    || left.bottom + padding <= right.top
    || left.top >= right.bottom + padding);
}

function labelRectangle(centerX, centerY, width, height) {
  return {
    left: centerX - width / 2,
    right: centerX + width / 2,
    top: centerY - height / 2,
    bottom: centerY + height / 2
  };
}

function renderList() {
  elements.count.textContent = String(state.places.length);
  elements.clear.hidden = !isAdmin() || state.places.length === 0;
  if (!state.places.length) {
    elements.list.innerHTML = '<div class="empty">登録地点はありません。</div>';
    return;
  }
  elements.list.innerHTML = state.places.map((place) => `
    <article class="place-item${place.id === state.editingId ? " is-editing" : ""}">
      <button class="place-main" type="button" data-focus="${place.id}">
        <span class="place-name">${escapeHtml(place.name)}</span>
        <span class="place-meta">半径 ${place.radius.toLocaleString("ja-JP")}m${showsName(place) ? " · 地点名表示" : ""}${place.memo ? " · メモあり" : ""}</span>
      </button>
      ${isAdmin() ? `<span class="place-actions">
        <button class="edit-one" type="button" data-edit="${place.id}" aria-label="${escapeHtml(place.name)}を編集">編集</button>
        <button class="delete-one" type="button" data-delete="${place.id}" aria-label="${escapeHtml(place.name)}を削除">×</button>
      </span>` : ""}
    </article>`).join("");
  elements.list.querySelectorAll("[data-focus]").forEach((button) => button.addEventListener("click", () => focusPlace(button.dataset.focus)));
  elements.list.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => editPlace(button.dataset.edit)));
  elements.list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deletePlace(button.dataset.delete)));
}

function focusPlace(id) {
  const place = state.places.find((item) => item.id === id);
  if (!place) return;
  map.setView([place.lat, place.lng], zoomForRadius(place.radius), { animate: true });
  if (!place.memo && !showsName(place)) state.layers.get(id)?.marker.openTooltip();
}

async function deletePlace(id) {
  const place = state.places.find((item) => item.id === id);
  if (!place || !confirm(`「${place.name}」を削除しますか？`)) return;
  try {
    await apiRequest("delete", { id }, true);
    if (state.editingId === id) resetEditor();
    await reloadPlaces();
  } catch (error) {
    handleApiError(error);
  }
}

async function clearAllPlaces() {
  if (!confirm("登録地点をすべて削除しますか？")) return;
  try {
    await apiRequest("clear", {}, true);
    resetEditor();
    await reloadPlaces();
  } catch (error) {
    handleApiError(error);
  }
}

async function changePassword() {
  const newPassword = elements.newPassword.value;
  elements.passwordMessage.textContent = "";
  if (newPassword.length < 4) {
    elements.passwordMessage.textContent = "4文字以上で入力してください。";
    return;
  }
  elements.changePassword.disabled = true;
  try {
    const result = await apiRequest("changePassword", { newPassword }, true);
    state.adminToken = result.token;
    elements.newPassword.value = "";
    elements.passwordMessage.textContent = "パスワードを変更しました。";
  } catch (error) {
    handleApiError(error);
  } finally {
    elements.changePassword.disabled = false;
  }
}

function handleApiError(error) {
  if (error.status === 401) {
    leaveAdminMode();
    showConnectionMessage("管理セッションの有効期限が切れました。もう一度パスワードを入力してください。");
    return;
  }
  showConnectionMessage(error.message);
}

async function apiRequest(action, payload = {}, authenticated = false) {
  if (!API_URL) throw new Error("Supabase接続先が未設定です。");
  const headers = { "Content-Type": "application/json" };
  if (authenticated && state.adminToken) headers.Authorization = `Bearer ${state.adminToken}`;
  let response;
  try {
    response = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify({ action, ...payload }) });
  } catch {
    throw new Error("サーバーに接続できません。");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || "サーバー処理に失敗しました。");
    error.status = response.status;
    throw error;
  }
  return result;
}

function fitSavedPlaces() {
  if (!state.places.length) return;
  const bounds = L.latLngBounds(state.places.map((place) => [place.lat, place.lng]));
  map.fitBounds(bounds.pad(.35), { maxZoom: 15 });
}

function clearPreview() {
  state.previewMarker?.remove();
  state.previewCircle?.remove();
  state.previewMarker = null;
  state.previewCircle = null;
}

function pointIcon(selected = false) {
  return L.divIcon({ className: "point-marker", iconSize: [20, 20], iconAnchor: [10, 10], html: `<span class="point-dot${selected ? " selected" : ""}"></span>` });
}

function circleStyle(radius) {
  return { radius, color: "#174c45", fillColor: "#4ba58c", fillOpacity: .13, weight: 2, bubblingMouseEvents: true };
}

function showsName(place) {
  return place.showName !== false;
}

function normalizedRadius() {
  return Math.min(50000, Math.max(10, Number(elements.radius.value) || 500));
}

function zoomForRadius(radius) {
  if (radius <= 100) return 18;
  if (radius <= 300) return 17;
  if (radius <= 700) return 16;
  if (radius <= 1500) return 15;
  if (radius <= 4000) return 13;
  return 11;
}

function showConnectionMessage(message) {
  elements.connection.textContent = message;
  elements.connection.hidden = false;
}

function hideConnectionMessage() {
  elements.connection.hidden = true;
  elements.connection.textContent = "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
