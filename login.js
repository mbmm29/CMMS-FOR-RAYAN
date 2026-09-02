document.addEventListener("DOMContentLoaded", () => {

    const loginForm = document.getElementById("loginForm");
    const usernameInput = document.getElementById("username");
    const passwordInput = document.getElementById("password");

    const loginButton = document.getElementById("loginButton");
    const loginError = document.getElementById("loginError");


    if (!loginForm) {
        console.error("loginForm not found.");
        return;
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

            console.log("Attempting login:", username);

            const response = await login(
                username,
                password
            );

            console.log("Login successful:", response);


            if (!response.access_token) {
                throw new Error(
                    "Login succeeded but no access token was returned."
                );
            }


            saveSession(response);


            /*
             * Verify the token with /me
             */
            const user = await getCurrentUser();

            console.log("Authenticated user:", user);


            localStorage.setItem(
                "user",
                JSON.stringify(user)
            );


            /*
             * Go to the separate Dashboard page
             */
            window.location.href = "index.html#dashboard";


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
