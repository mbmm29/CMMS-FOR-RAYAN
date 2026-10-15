// The production page is served by FastAPI on port 8000.  During local
// preview it may be opened from another port (for example 4173 or 5500),
// so point those previews to the running API instead of requesting their
// own static server.  This prevents the browser-level "Failed to fetch"
// error when changing between the two local URLs.
const API_BASE_URL = (() => {
    const { protocol, hostname, port, origin } = window.location;
    const isLocalHost = hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "[::1]"
        || hostname === "::1";

    if (protocol === "file:" || (isLocalHost && port !== "8000")) {
        const host = !hostname || hostname === "::1" ? "localhost" : hostname;
        return `http://${host}:8000`;
    }

    return origin;
})();

function formatApiDetail(detail, status) {
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
        const text = detail
            .map((item) => item?.msg || item?.detail || (typeof item === 'string' ? item : ''))
            .filter(Boolean)
            .join(' · ');
        if (text) return text;
    }
    if (detail && typeof detail === 'object' && detail.msg) return String(detail.msg);
    return `HTTP ${status}`;
}

async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem("access_token");
    const wantsBlob = options.blob === true;
    const { blob: _blob, headers: optionHeaders, ...request } = options;

    const headers = { ...(optionHeaders || {}) };
    if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
    }

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    let response;

    try {
        response = await fetch(
            `${API_BASE_URL}${endpoint}`,
            {
                ...request,
                headers
            }
        );
    } catch (_) {
        throw new Error(
            "Cannot connect to the CMMS server. Open the system from http://localhost:8000 and try again."
        );
    }

    if (wantsBlob) {
        if (!response.ok) {
            let data = null;
            try {
                data = await response.json();
            } catch (_) {
                data = null;
            }
            throw new Error(formatApiDetail(data?.detail, response.status));
        }
        return response.blob();
    }

    let data = null;

    try {
        data = await response.json();
    } catch (_) {
        data = null;
    }

    if (!response.ok) {
        throw new Error(formatApiDetail(data?.detail, response.status));
    }

    return data;
}


async function login(username, password) {

    return await apiRequest("/login", {
        method: "POST",
        body: JSON.stringify({
            username: username,
            password: password
        })
    });

}


async function getCurrentUser() {

    return await apiRequest("/me", {
        method: "GET"
    });

}


function saveSession(loginResponse) {

    if (loginResponse?.access_token) {
        localStorage.setItem("access_token", loginResponse.access_token);
    }

    const previous = getSavedUser() || {};
    const next = {
        ...previous,
        ...loginResponse,
    };
    delete next.access_token;
    localStorage.setItem("user", JSON.stringify(next));

}


function getSavedUser() {

    const user = localStorage.getItem("user");

    if (!user) {
        return null;
    }

    try {
        return JSON.parse(user);
    } catch (_) {
        return null;
    }

}


function hasSavedSession() {
    return Boolean(localStorage.getItem("access_token") && getSavedUser());
}


function homePageForUser(user) {
    if (user?.role === "LUBRICATION_TECHNICIAN") return "lubrication";
    if (user?.role === "TECHNICIAN") return "work-orders";
    return "dashboard";
}


async function restoreSession() {
    if (!localStorage.getItem("access_token")) {
        return null;
    }
    try {
        const refreshed = await apiRequest("/auth/refresh", { method: "POST" });
        saveSession(refreshed);
        const user = await getCurrentUser();
        saveSession({ ...user, ...refreshed });
        return getSavedUser();
    } catch (_) {
        logout();
        return null;
    }
}


function logout() {

    localStorage.removeItem("access_token");
    localStorage.removeItem("user");

}
