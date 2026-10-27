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

/**
 * POST multipart upload with upload + processing progress callbacks.
 * onProgress(percent 0–100, phase: 'upload' | 'processing' | 'done')
 */
function apiUploadWithProgress(endpoint, formData, onProgress) {
    return new Promise((resolve, reject) => {
        const token = localStorage.getItem('access_token');
        const xhr = new XMLHttpRequest();
        let processingTimer = null;
        let processingPct = 72;

        const stopProcessingPulse = () => {
            if (processingTimer) {
                clearInterval(processingTimer);
                processingTimer = null;
            }
        };

        const startProcessingPulse = () => {
            stopProcessingPulse();
            processingPct = Math.max(processingPct, 72);
            if (typeof onProgress === 'function') onProgress(processingPct, 'processing');
            processingTimer = setInterval(() => {
                if (processingPct < 92) {
                    processingPct += 1;
                    if (typeof onProgress === 'function') onProgress(processingPct, 'processing');
                }
            }, 450);
        };

        xhr.open('POST', `${API_BASE_URL}${endpoint}`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) {
                if (typeof onProgress === 'function') onProgress(15, 'upload');
                return;
            }
            const ratio = event.total ? event.loaded / event.total : 0;
            const pct = Math.min(70, Math.round(ratio * 70));
            if (typeof onProgress === 'function') onProgress(pct, 'upload');
        };

        xhr.upload.onload = () => {
            startProcessingPulse();
        };

        xhr.onerror = () => {
            stopProcessingPulse();
            reject(new Error(
                'Cannot connect to the CMMS server. Open the system from http://localhost:8000 and try again.'
            ));
        };

        xhr.onload = () => {
            stopProcessingPulse();
            let data = null;
            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch (_) {
                data = null;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                if (typeof onProgress === 'function') onProgress(100, 'done');
                resolve(data);
                return;
            }
            reject(new Error(formatApiDetail(data?.detail, xhr.status)));
        };

        if (typeof onProgress === 'function') onProgress(2, 'upload');
        xhr.send(formData);
    });
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
