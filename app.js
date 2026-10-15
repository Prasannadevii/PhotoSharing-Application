
/* PhotoShare - Cognito, API Gateway, Lambda, private S3 */
"use strict";

// 1. AWS CONFIGURATION
const COGNITO_DOMAIN =
  "https://ap-southeast-2xcjyhmnje.auth.ap-southeast-2.amazoncognito.com";

const COGNITO_CLIENT_ID = "41cie4g9t888rgsklmt6gss1iu";
const REDIRECT_URI = "https://photosharing-application.onrender.com/index.html";

const API_BASE =
  "https://aayqmlpqj9.execute-api.ap-southeast-2.amazonaws.com";

const UPLOAD_URL_API = `${API_BASE}/upload-url`;
const LIST_PHOTOS_API = `${API_BASE}/photos`;
const DELETE_PHOTO_API = `${API_BASE}/photos/delete`;

const TOKEN_KEY = "photoshare_cognito_tokens";
const VERIFIER_KEY = "photoshare_pkce_verifier";
const STATE_KEY = "photoshare_oauth_state";

const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const uploadedPhotos = [];
let toastTimer;

// 2. LOGIN HELPERS
function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function base64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );

  return base64Url(digest);
}

// 3. COGNITO LOGIN
async function cognitoLogin() {
  try {
    const verifier = randomString();
    const state = randomString();
    const challenge = await generateCodeChallenge(verifier);

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: COGNITO_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email",
      state,
      code_challenge_method: "S256",
      code_challenge: challenge
    });

    window.location.assign(
      `${COGNITO_DOMAIN}/oauth2/authorize?${params}`
    );
  } catch (error) {
    console.error("Login error:", error);
    showToast("Unable to start sign in.", true);
  }
}

// 4. EXCHANGE LOGIN CODE FOR TOKENS
async function exchangeCode(code, returnedState) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const expectedState = sessionStorage.getItem(STATE_KEY);

  if (
    !verifier ||
    !expectedState ||
    returnedState !== expectedState
  ) {
    throw new Error("Login verification failed. Please sign in again.");
  }

  const response = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: COGNITO_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: verifier
    })
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.error_description || result.error || "Cognito login failed."
    );
  }

  if (!result.id_token || !result.access_token) {
    throw new Error("Cognito did not return the required tokens.");
  }

  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(result));
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  window.history.replaceState({}, document.title, REDIRECT_URI);
}

// 5. SESSION HELPERS
function getTokens() {
  try {
    return JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
  } catch {
    return null;
  }
}

function decodeToken(token) {
  try {
    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;

    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload += "=".repeat((4 - payload.length % 4) % 4);

    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

function getCurrentUser() {
  const tokens = getTokens();
  if (!tokens?.id_token) return null;

  const user = decodeToken(tokens.id_token);

  if (!user?.exp || user.exp * 1000 <= Date.now()) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }

  return user;
}

function getAccessToken() {
  const tokens = getTokens();
  const user = decodeToken(tokens?.id_token);

  if (
    !tokens?.access_token ||
    !user?.exp ||
    user.exp * 1000 <= Date.now()
  ) {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }

  return tokens.access_token;
}

// 6. SIGN OUT
function cognitoLogout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  uploadedPhotos.splice(0, uploadedPhotos.length);
  renderGallery();
  renderAccount();

  const params = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    logout_uri: REDIRECT_URI
  });

  window.location.assign(`${COGNITO_DOMAIN}/logout?${params}`);
}

// 7. STATUS MESSAGES
function showToast(message, isError = false) {
  const toast = document.getElementById("toast");

  if (!toast) {
    console.log(message);
    return;
  }

  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 4000);
}

function setUploadStatus(message, isError = false) {
  const preview = document.getElementById("filePreview");
  if (!preview) return;

  preview.textContent = message;
  preview.classList.toggle("error", isError);
  preview.classList.remove("hidden");
}

// 8. ADMIN NAVIGATION VISIBILITY
function isAdminUser() {
  const tokens = getTokens();

  return [tokens?.id_token, tokens?.access_token].some(token => {
    const claims = decodeToken(token);
    const groups = claims?.["cognito:groups"];

    const list = Array.isArray(groups)
      ? groups
      : String(groups || "").split(/[\s,\[\]"]+/);

    return list.some(group => group.toLowerCase() === "admin");
  });
}

function renderAccount() {
  const user = getCurrentUser();

  const userLabel = document.getElementById("userLabel");
  const loginButton = document.getElementById("loginOpen");
  const logoutButton = document.getElementById("logoutBtn");
  const adminLink = document.getElementById("adminLink");

  if (userLabel) {
    userLabel.textContent = user
      ? user.email || user.username || "Signed in"
      : "Guest user";
  }

  if (loginButton) {
    loginButton.classList.toggle("hidden", Boolean(user));
  }

  if (logoutButton) {
    logoutButton.classList.toggle("hidden", !user);
  }

  if (adminLink) {
    adminLink.classList.toggle(
      "hidden",
      !(user && isAdminUser())
    );
  }
}

// 9. LOCAL STORAGE HELPERS
function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage may be unavailable.
  }
}

function prettifyName(fileName) {
  const clean = String(fileName || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "Untitled photo";

  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function saveTitle(key, title) {
  if (!key || !title) return;

  const titles = readStore("photoshare_titles");
  titles[key] = title;
  writeStore("photoshare_titles", titles);
}

function isFavorite(id) {
  return Boolean(readStore("photoshare_favorites")[id]);
}

function toggleFavorite(id) {
  const favorites = readStore("photoshare_favorites");

  if (favorites[id]) {
    delete favorites[id];
  } else {
    favorites[id] = true;
  }

  writeStore("photoshare_favorites", favorites);
  return Boolean(favorites[id]);
}

// 10. EMPTY GALLERY
function setEmptyState(element, title, message, showCta = false) {
  element.innerHTML =
    `<div class="empty-icon">▧</div>` +
    `<h3>${title}</h3><p>${message}</p>` +
    (showCta
      ? '<a href="#upload" class="btn btn-primary">Add your first photo</a>'
      : "");
}

// 11. RENDER GALLERY
function renderGallery() {
  const grid = document.getElementById("galleryGrid");
  const emptyState = document.getElementById("emptyState");
  const photoCount = document.getElementById("photoCount");
  if (!grid) return;

  const search = (
    document.getElementById("searchPhotos")?.value || ""
  ).trim().toLowerCase();

  const filtered = uploadedPhotos.filter(photo =>
    String(photo.title || "").toLowerCase().includes(search) ||
    String(photo.fileName || "").toLowerCase().includes(search)
  );

  grid.innerHTML = "";

  filtered.forEach((photo, index) => {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.style.setProperty("--i", Math.min(index, 8));

    const thumb = document.createElement("div");
    thumb.className = "thumb";

    const image = document.createElement("img");
    image.src = photo.viewUrl || photo.previewUrl || "";
    image.alt = photo.title || photo.fileName || "Photo";
    image.loading = "lazy";

    const label = document.createElement("div");
    label.className = "photo-label";

    const heading = document.createElement("h3");
    heading.textContent = photo.title || prettifyName(photo.fileName);
    label.appendChild(heading);

    const likeButton = document.createElement("button");
    likeButton.type = "button";
    likeButton.className = "like-btn";
    likeButton.dataset.action = "like";
    likeButton.dataset.id = photo.id;
    likeButton.setAttribute("aria-label", "Favourite this photo");
    likeButton.textContent = "♥";
    likeButton.classList.toggle("liked", isFavorite(photo.id));

    const body = document.createElement("div");
    body.className = "gallery-card-body";

    const description = document.createElement("p");
    const dateText = photo.uploadedAt
      ? ` · ${new Date(photo.uploadedAt).toLocaleString()}`
      : "";

    description.textContent =
      `${photo.fileName || "Photo"} · Stored in private S3${dateText}`;

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.dataset.action = "view";
    viewButton.dataset.id = photo.id;
    viewButton.textContent = "View";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "delete-btn";
    removeButton.dataset.action = "remove";
    removeButton.dataset.id = photo.id;
    removeButton.textContent = "Remove";

    actions.append(viewButton, removeButton);
    body.append(description, actions);
    thumb.append(image, likeButton, label);
    card.append(thumb, body);
    grid.appendChild(card);
  });

  if (emptyState) {
    emptyState.classList.toggle("hidden", filtered.length > 0);

    if (filtered.length === 0) {
      if (search) {
        setEmptyState(
          emptyState,
          "No matches found",
          "Try a different title or file name."
        );
      } else if (getCurrentUser()) {
        setEmptyState(
          emptyState,
          "Your gallery is waiting",
          "Upload your first photo to get started.",
          true
        );
      } else {
        setEmptyState(
          emptyState,
          "Sign in to view your photos",
          "Your saved photos appear here after you sign in."
        );
      }
    }
  }

  if (photoCount) {
    photoCount.textContent = String(uploadedPhotos.length);
  }
}

// 12. LOAD SAVED PHOTOS
async function loadSavedPhotos({ quiet = false } = {}) {
  const accessToken = getAccessToken();

  if (!accessToken) {
    uploadedPhotos.splice(0, uploadedPhotos.length);
    renderGallery();
    return;
  }

  try {
    const response = await fetch(LIST_PHOTOS_API, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        result.message || `Photo list failed (HTTP ${response.status}).`
      );
    }

    if (!Array.isArray(result.photos)) {
      throw new Error("The photo-list API did not return a photos array.");
    }

    const titles = readStore("photoshare_titles");

    uploadedPhotos.splice(
      0,
      uploadedPhotos.length,
      ...result.photos.map(item => ({
        id: item.photoId,
        title:
          (item.title && item.title !== item.fileName
            ? item.title
            : titles[item.s3Key]) ||
          prettifyName(item.fileName || item.title),
        fileName: item.fileName || item.title || "Photo",
        key: item.s3Key || "",
        uploadedAt: item.uploadedAt || "",
        viewUrl: item.viewUrl || ""
      }))
    );

    renderGallery();
  } catch (error) {
    console.error("Could not load saved photos:", error);

    if (!quiet) {
      showToast(`Could not load saved photos: ${error.message}`, true);
    }
  }
}

// 13. FILE PREVIEW
function showSelectedFile() {
  const input = document.getElementById("photoFile");
  const file = input?.files?.[0];
  if (!file) return;

  if (!ALLOWED_TYPES.has(file.type)) {
    setUploadStatus("Choose a JPEG, PNG, or WebP image.", true);
    input.value = "";
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    setUploadStatus("The image must be 10 MB or smaller.", true);
    input.value = "";
    return;
  }

  setUploadStatus(
    `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
  );
}

// 14. UPLOAD PHOTO
async function uploadSelectedPhoto(event) {
  event.preventDefault();

  const form = document.getElementById("uploadForm");
  const titleInput = document.getElementById("photoTitle");
  const fileInput = document.getElementById("photoFile");
  const uploadButton = document.getElementById("uploadBtn");

  const title = (titleInput?.value || "").trim();
  const file = fileInput?.files?.[0];

  if (!getCurrentUser()) {
    showToast("Please sign in before uploading.", true);
    return;
  }

  const accessToken = getAccessToken();
  if (!accessToken) {
    showToast("Your session expired. Please sign in again.", true);
    return;
  }

  if (!title) {
    showToast("Enter a title for your photo.", true);
    titleInput?.focus();
    return;
  }

  if (!file) {
    showToast("Choose a photo first.", true);
    fileInput?.focus();
    return;
  }

  if (!ALLOWED_TYPES.has(file.type) || file.size > MAX_FILE_SIZE) {
    showToast("Choose a JPEG, PNG, or WebP image up to 10 MB.", true);
    return;
  }

  if (uploadButton) {
    uploadButton.disabled = true;
    uploadButton.textContent = "Uploading...";
  }

  setUploadStatus("Requesting a secure upload URL...");

  try {
    const apiResponse = await fetch(UPLOAD_URL_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type
      })
    });

    const apiResult = await apiResponse.json().catch(() => ({}));

    if (!apiResponse.ok) {
      throw new Error(
        apiResult.message || `API request failed (HTTP ${apiResponse.status}).`
      );
    }

    if (!apiResult.uploadUrl || !apiResult.key) {
      throw new Error("The API did not return an upload URL.");
    }

    setUploadStatus("Uploading photo to private S3 storage...");

    const s3Response = await fetch(apiResult.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file
    });

    if (!s3Response.ok) {
      throw new Error(
        `S3 upload failed (HTTP ${s3Response.status}). Check S3 CORS.`
      );
    }

    saveTitle(apiResult.key, title);
    form?.reset();

    setUploadStatus("Upload successful! Saving photo details...");
    showToast("Photo uploaded successfully to private S3.");

    let loaded = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve =>
        setTimeout(resolve, attempt === 0 ? 700 : 1000)
      );

      await loadSavedPhotos({ quiet: true });

      if (uploadedPhotos.some(photo => photo.key === apiResult.key)) {
        loaded = true;
        break;
      }
    }

    setUploadStatus(
      loaded
        ? "Upload successful! Photo saved and gallery refreshed."
        : "Upload succeeded. Metadata may still be processing; refresh shortly."
    );
  } catch (error) {
    console.error("Photo upload failed:", error);

    const message =
      error instanceof TypeError && error.message === "Failed to fetch"
        ? "Network request failed. Check the Network tab for API or S3 CORS errors."
        : error.message || "Upload failed.";

    setUploadStatus(message, true);
    showToast(message, true);
  } finally {
    if (uploadButton) {
      uploadButton.disabled = false;
      uploadButton.textContent = "Upload photo";
    }
  }
}

// 15. GALLERY ACTIONS INCLUDING PERMANENT DELETE
function initGalleryActions() {
  const grid = document.getElementById("galleryGrid");
  if (!grid) return;

  grid.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const photo = uploadedPhotos.find(
      item => item.id === button.dataset.id
    );
    if (!photo) return;

    if (button.dataset.action === "like") {
      const liked = toggleFavorite(photo.id);
      button.classList.toggle("liked", liked);
      showToast(liked ? "Added to favourites." : "Removed from favourites.");
      return;
    }

    if (button.dataset.action === "view") {
      if (photo.viewUrl) {
        window.open(photo.viewUrl, "_blank", "noopener,noreferrer");
      } else {
        showToast("No viewing URL is available. Reload the gallery.", true);
      }
      return;
    }

    if (button.dataset.action !== "remove") return;

    if (!window.confirm("Permanently delete this photo from cloud storage?")) {
      return;
    }

    const accessToken = getAccessToken();
    if (!accessToken) {
      showToast("Your session expired. Please sign in again.", true);
      return;
    }

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Deleting...";

    try {
      const response = await fetch(DELETE_PHOTO_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          photoId: photo.id
        })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.success === false) {
        throw new Error(
          result.message || `Photo deletion failed (HTTP ${response.status}).`
        );
      }

      await loadSavedPhotos({ quiet: true });
      showToast(result.message || "Photo deleted successfully.");
    } catch (error) {
      console.error("Photo deletion failed:", error);
      showToast(error.message || "Photo deletion failed.", true);
      button.disabled = false;
      button.textContent = originalText;
    }
  });
}

// 16. INITIALIZE
async function initializePhotoShare() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const authError = params.get("error");

  if (authError) {
    const description = params.get("error_description") || authError;

    window.history.replaceState({}, document.title, REDIRECT_URI);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);

    showToast(`Cognito sign-in failed: ${description}`, true);
  } else if (code) {
    try {
      await exchangeCode(code, state);
      showToast("Signed in successfully.");
    } catch (error) {
      console.error("Cognito callback failed:", error);

      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);

      window.history.replaceState({}, document.title, REDIRECT_URI);
      showToast(error.message || "Sign-in failed.", true);
    }
  }

  document.getElementById("loginOpen")
    ?.addEventListener("click", cognitoLogin);

  document.getElementById("logoutBtn")
    ?.addEventListener("click", cognitoLogout);

  document.getElementById("uploadForm")
    ?.addEventListener("submit", uploadSelectedPhoto);

  document.getElementById("photoFile")
    ?.addEventListener("change", showSelectedFile);

  document.getElementById("searchPhotos")
    ?.addEventListener("input", renderGallery);

  initGalleryActions();
  renderAccount();
  renderGallery();

  if (getCurrentUser()) {
    await loadSavedPhotos();
  }

  console.log(
    getCurrentUser() ? "PhotoShare: signed in." : "PhotoShare: guest session."
  );
}

// 17. UI ENHANCEMENTS
function initUI() {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const topbar = document.querySelector(".topbar");
  const onScroll = () =>
    topbar?.classList.toggle("scrolled", window.scrollY > 8);

  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = document.getElementById("menuToggle");
  const nav = document.getElementById("mainNav");

  const setMenu = open => {
    nav?.classList.toggle("open", open);
    toggle?.setAttribute("aria-expanded", String(open));
  };

  toggle?.addEventListener("click", () => {
    if (nav) setMenu(!nav.classList.contains("open"));
  });

  nav?.addEventListener("click", event => {
    if (event.target.closest("a")) setMenu(false);
  });

  const links = [...document.querySelectorAll("#mainNav a")];
  const page = location.pathname.split("/").pop() || "index.html";

  if (page !== "index.html" && page !== "") {
    links.forEach(link => {
      link.classList.toggle("active", link.getAttribute("href") === page);
    });
  } else if ("IntersectionObserver" in window) {
    const sections = ["home", "gallery", "upload"]
      .map(id => document.getElementById(id))
      .filter(Boolean);

    const spy = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        links.forEach(link => {
          link.classList.toggle(
            "active",
            link.getAttribute("href") === `index.html#${entry.target.id}`
          );
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });

    sections.forEach(section => spy.observe(section));
  }

  const revealItems = document.querySelectorAll(".reveal");

  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealItems.forEach(item => item.classList.add("in"));
  } else {
    const revealer = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    revealItems.forEach(item => revealer.observe(item));
  }

  const counters = document.querySelectorAll("[data-count]");

  if ("IntersectionObserver" in window && !reduceMotion) {
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const element = entry.target;
        const target = parseFloat(element.dataset.count);
        const decimals = Number(element.dataset.decimals || 0);
        const suffix = element.dataset.suffix || "";
        const start = performance.now();
        const duration = 1400;

        function tick(now) {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);

          element.textContent =
            (target * eased).toFixed(decimals) + suffix;

          if (progress < 1) requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
        obs.unobserve(element);
      });
    }, { threshold: 0.6 });

    counters.forEach(counter => observer.observe(counter));
  }

  const dropzone = document.querySelector(".dropzone");
  const fileInput = document.getElementById("photoFile");

  if (dropzone && fileInput) {
    ["dragenter", "dragover"].forEach(name => {
      dropzone.addEventListener(name, event => {
        event.preventDefault();
        dropzone.classList.add("drag");
      });
    });

    ["dragleave", "drop"].forEach(name => {
      dropzone.addEventListener(name, event => {
        event.preventDefault();
        dropzone.classList.remove("drag");
      });
    });

    dropzone.addEventListener("drop", event => {
      const files = event.dataTransfer?.files;
      if (!files?.length) return;

      fileInput.files = files;
      fileInput.dispatchEvent(new Event("change"));
    });
  }
}

// 18. START APPLICATION
function onReady(callback) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", callback, { once: true });
  } else {
    callback();
  }
}

onReady(initUI);
onReady(initializePhotoShare);

// Optional debugging helpers
window.cognitoLogin = cognitoLogin;
window.cognitoLogout = cognitoLogout;
window.getCurrentUser = getCurrentUser;
window.isAdminUser = isAdminUser;
window.uploadSelectedPhoto = uploadSelectedPhoto;
window.loadSavedPhotos = loadSavedPhotos;
