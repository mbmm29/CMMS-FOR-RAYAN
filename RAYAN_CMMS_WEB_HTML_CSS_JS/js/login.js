document.addEventListener("DOMContentLoaded", async () => {

    const loginForm = document.getElementById("loginForm");
    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");

    const loginButton = document.getElementById("loginButton");
    const loginError = document.getElementById("loginError");


    if (!loginForm) {
        console.error("loginForm not found.");
        return;
    }

    // Already signed in on this browser? Skip the form until Sign out.
    if (hasSavedSession()) {
        const user = await restoreSession();
        if (user) {
            window.location.replace(`index.html#${homePageForUser(user)}`);
            return;
        }
    }


    loginForm.addEventListener("submit", async (event) => {

        event.preventDefault();

        loginError.textContent = "";
        loginError.style.display = "none";

        const username = usernameInput.value.trim();
        const password = passwordInput.value;


        if (!username || !password) {

            loginError.textContent =
                "Please enter username and password.";

            loginError.style.display = "block";

            return;
        }


        loginButton.disabled = true;
        loginButton.textContent = "SIGNING IN...";


        try {

            const response = await login(
                username,
                password
            );


            if (!response.access_token) {
                throw new Error(
                    "Login succeeded but no access token was returned."
                );
            }


            saveSession(response);


            const user = await getCurrentUser();
            saveSession({ ...response, ...user });


            window.location.href = `index.html#${homePageForUser(user)}`;


        } catch (error) {

            console.error("Login failed:", error);

            loginError.textContent =
                error.message || "Login failed.";

            loginError.style.display = "block";

        } finally {

            loginButton.disabled = false;
            loginButton.textContent = "SIGN IN";

        }

    });

});
