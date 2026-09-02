/* =========================================================
   RAYAN CMMS
   Application Logic
========================================================= */

const API_BASE_URL = (() => {
    const { protocol, hostname, port, origin } = window.location;
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";

    if (protocol === "file:" || (isLocalHost && port !== "8000")) {
        return `http://${hostname || "localhost"}:8000`;
    }

    return origin;
})();


/* =========================================================
   ELEMENTS
========================================================= */

const loginPage =
    document.getElementById("loginPage");

const appPage =
    document.getElementById("appPage");

const loginForm =
    document.getElementById("loginForm");

const usernameInput =
    document.getElementById("username");

const passwordInput =
    document.getElementById("password");

const loginButton =
    document.getElementById("loginButton");

const loginError =
    document.getElementById("loginError");

const togglePassword =
    document.getElementById("togglePassword");

const logoutButton =
    document.getElementById("logoutButton");


/* =========================================================
   PASSWORD VISIBILITY
========================================================= */

togglePassword.addEventListener(
    "click",
    function () {

        if (
            passwordInput.type === "password"
        ) {

            passwordInput.type = "text";

            togglePassword.textContent = "🙈";

        } else {

            passwordInput.type = "password";

            togglePassword.textContent = "👁";

        }

    }
);


/* =========================================================
   LOGIN
========================================================= */

loginForm.addEventListener(
    "submit",
    async function (event) {

        event.preventDefault();

        loginError.textContent = "";

        const username =
            usernameInput.value.trim();

        const password =
            passwordInput.value;


        if (!username || !password) {

            loginError.textContent =
                "Please enter username and password.";

            return;
        }


        loginButton.disabled = true;

        loginButton.textContent =
            "SIGNING IN...";


        try {

            const response =
                await fetch(
                    `${API_BASE_URL}/login`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "Accept":
                                "application/json"
                        },

                        body: JSON.stringify({
                            username: username,
                            password: password
                        })
                    }
                );


            let data = {};

            try {

                data =
                    await response.json();

            } catch (_) {

                data = {};

            }


            if (!response.ok) {

                throw new Error(
                    data.detail ||
                    "Invalid username or password."
                );

            }


            /*
             * Save authentication information
             */

            const token =
                data.access_token ||
                data.token;

            if (token) {

                localStorage.setItem(
                    "rayan_token",
                    token
                );

            }


            localStorage.setItem(
                "rayan_user",
                JSON.stringify(data)
            );


            showDashboard(data);


        } catch (error) {

            console.error(
                "Login error:",
                error
            );


            loginError.textContent =
                error.message ||
                "Unable to connect to the server.";


        } finally {

            loginButton.disabled = false;

            loginButton.textContent =
                "SIGN IN";

        }

    }
);


/* =========================================================
   SHOW DASHBOARD
========================================================= */

function showDashboard(userData = {}) {

    loginPage.classList.add("hidden");

    appPage.classList.remove("hidden");


    const username =
        userData.username ||
        userData.user?.username ||
        usernameInput.value.trim() ||
        "User";


    const role =
        userData.role ||
        userData.user?.role ||
        "User";


    const initials =
        username
            .substring(0, 2)
            .toUpperCase();


    document.getElementById(
        "sidebarUsername"
    ).textContent = username;


    document.getElementById(
        "sidebarRole"
    ).textContent = role;


    document.getElementById(
        "profileUsername"
    ).textContent = username;


    document.getElementById(
        "profileRole"
    ).textContent = role;


    document.getElementById(
        "userAvatar"
    ).textContent = initials;


    document.getElementById(
        "profileAvatar"
    ).textContent = initials;

}


/* =========================================================
   LOGOUT
========================================================= */

logoutButton.addEventListener(
    "click",
    function () {

        localStorage.removeItem(
            "rayan_token"
        );

        localStorage.removeItem(
            "rayan_user"
        );


        appPage.classList.add(
            "hidden"
        );

        loginPage.classList.remove(
            "hidden"
        );


        loginForm.reset();

        loginError.textContent = "";

        passwordInput.type =
            "password";

        togglePassword.textContent =
            "👁";

    }
);


/* =========================================================
   NAVIGATION
========================================================= */

const navItems =
    document.querySelectorAll(
        ".nav-item"
    );


navItems.forEach(
    function (item) {

        item.addEventListener(
            "click",
            function () {

                navItems.forEach(
                    function (nav) {
                        nav.classList.remove(
                            "active"
                        );
                    }
                );


                this.classList.add(
                    "active"
                );


                const page =
                    this.dataset.page;


                if (page !== "dashboard") {

                    showPlaceholderPage(
                        page
                    );

                }

            }
        );

    }
);


/* =========================================================
   PLACEHOLDER PAGES
========================================================= */

function showPlaceholderPage(page) {

    const titles = {

        "work-orders":
            "Work Orders",

        "daily-reports":
            "Daily Reports",

        "pm":
            "PM Schedule",

        "equipment":
            "Equipment",

        "components":
            "Components",

        "technicians":
            "Technicians",

        "kpi":
            "KPI",

        "reports":
            "Reports",

        "sop":
            "SOP",

        "machine-records":
            "Machine Records",

        "settings":
            "Settings"

    };


    const title =
        titles[page] ||
        "Page";


    document.getElementById(
        "pageTitle"
    ).textContent = title;


    document.getElementById(
        "pageSubtitle"
    ).textContent =
        "This module will be designed next.";


    document.getElementById(
        "pageContent"
    ).innerHTML = `

        <section class="panel placeholder-panel">

            <div class="placeholder-content">

                <div class="placeholder-icon">
                    ⚙
                </div>

                <h2>
                    ${title}
                </h2>

                <p>
                    Interface under development.
                </p>

            </div>

        </section>

    `;

}


/* =========================================================
   DASHBOARD NAVIGATION
========================================================= */

function showDashboardPage() {

    window.location.reload();

}


/* =========================================================
   AUTO LOGIN FROM LOCAL STORAGE
========================================================= */

window.addEventListener(
    "DOMContentLoaded",
    function () {

        const token =
            localStorage.getItem(
                "rayan_token"
            );


        const savedUser =
            localStorage.getItem(
                "rayan_user"
            );


        if (
            token &&
            savedUser
        ) {

            try {

                const user =
                    JSON.parse(
                        savedUser
                    );

                showDashboard(user);

            } catch (_) {

                localStorage.removeItem(
                    "rayan_token"
                );

                localStorage.removeItem(
                    "rayan_user"
                );

            }

        }

    }
);