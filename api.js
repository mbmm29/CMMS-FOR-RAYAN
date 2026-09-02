// The production page is served by FastAPI on port 8000.  During local
// preview it may be opened from another port (for example 4173 or 5500),
// so point those previews to the running API instead of requesting their
// own static server.  This prevents the browser-level "Failed to fetch"
// error when changing between the two local URLs.
const API_BASE_URL = (() => {
    const { protocol, hostname, port, origin } = window.location;
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";

    if (protocol === "file:" || (isLocalHost && port !== "8000")) {
        return `http://${hostname || "localhost"}:8000`;
    }

    return origin;
})();

async function apiRequest(endpoint, options = {}) {
    const token = localStorage.getItem("access_token");

    const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
    };

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    let response;

    try {
        response = await fetch(
            `${API_BASE_URL}${endpoint}`,
            {
                ...options,
                headers
            }
        );
    } catch (_) {
        throw new Error(
            "Cannot connect to the CMMS server. Open the system from http://localhost:8000 and try again."
        );
    }

    let data = null;

    try {
        data = await response.json();
    } catch (_) {
        data = null;
    }

    if (!response.ok) {
        const message =
            data?.detail ||
            `HTTP ${response.status}`;

        throw new Error(message);
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

    localStorage.setItem(
        "access_token",
        loginResponse.access_token
    );

    localStorage.setItem(
        "user",
        JSON.stringify(loginResponse)
    );

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


function logout() {

    localStorage.removeItem("access_token");
    localStorage.removeItem("user");

}
