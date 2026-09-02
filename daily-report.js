document.addEventListener("DOMContentLoaded", () => {

    /* =====================================================
       CONFIG
    ===================================================== */

    const API_BASE_URL = (() => {
        const { protocol, hostname, port, origin } = window.location;
        const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";

        if (protocol === "file:" || (isLocalHost && port !== "8000")) {
            return `http://${hostname || "localhost"}:8000`;
        }

        return origin;
    })();


    /* =====================================================
       ELEMENTS
    ===================================================== */

    const tableBody =
        document.getElementById(
            "reportsTableBody"
        );

    const globalSearch =
        document.getElementById(
            "globalSearch"
        );

    const dateFrom =
        document.getElementById(
            "dateFrom"
        );

    const dateTo =
        document.getElementById(
            "dateTo"
        );

    const rowsPerPageSelect =
        document.getElementById(
            "rowsPerPage"
        );

    const paginationInfo =
        document.getElementById(
            "paginationInfo"
        );

    const paginationControls =
        document.getElementById(
            "paginationControls"
        );

    const detailsPanel =
        document.getElementById(
            "detailsPanel"
        );

    const detailsContent =
        document.getElementById(
            "detailsContent"
        );

    const closeDetails =
        document.getElementById(
            "closeDetails"
        );

    const newReportButton =
        document.getElementById(
            "newReportButton"
        );

    const selectAll =
        document.getElementById(
            "selectAll"
        );


    /* =====================================================
       STATE
    ===================================================== */

    let allReports = [];

    let filteredReports = [];

    let currentPage = 1;

    let rowsPerPage =
        Number(
            rowsPerPageSelect?.value || 10
        );

    let activeStatus = "all";


    /* =====================================================
       TOKEN
    ===================================================== */

    function getToken() {

        return localStorage.getItem(
            "access_token"
        );

    }


    /* =====================================================
       API REQUEST
    ===================================================== */

    async function apiRequest(
        endpoint,
        options = {}
    ) {

        const token =
            getToken();


        const headers = {

            "Content-Type":
                "application/json",

            ...(options.headers || {})

        };


        if (token) {

            headers[
                "Authorization"
            ] =
                `Bearer ${token}`;

        }


        const response =
            await fetch(
                `${API_BASE_URL}${endpoint}`,
                {
                    ...options,
                    headers
                }
            );


        let data = null;


        try {

            data =
                await response.json();

        } catch (_) {

            data = null;

        }


        if (!response.ok) {

            throw new Error(
                data?.detail ||
                `HTTP ${response.status}`
            );

        }


        return data;

    }


    /* =====================================================
       LOAD REPORTS
    ===================================================== */

    async function loadReports() {

        tableBody.innerHTML = `

            <tr>

                <td
                    colspan="11"
                    class="loading-cell"
                >
                    Loading reports...
                </td>

            </tr>

        `;


        try {

            const data =
                await apiRequest(
                    "/daily-reports"
                );


            /*
             * Backend response may be:
             *
             * [
             *   {...},
             *   {...}
             * ]
             *
             * or:
             *
             * {
             *   reports: [...]
             * }
             */

            if (Array.isArray(data)) {

                allReports =
                    data;

            } else {

                allReports =
                    data?.reports ||
                    data?.items ||
                    [];

            }


            /*
             * Sort newest first.
             */

            allReports.sort(
                (a, b) => {

                    const dateA =
                        new Date(
                            a.report_date ||
                            a.created_at ||
                            0
                        );

                    const dateB =
                        new Date(
                            b.report_date ||
                            b.created_at ||
                            0
                        );

                    return dateB - dateA;

                }
            );


            updateStatistics();

            applyFilters();


        } catch (error) {

            console.error(
                "Failed to load daily reports:",
                error
            );


            tableBody.innerHTML = `

                <tr>

                    <td
                        colspan="11"
                        class="loading-cell"
                    >

                        Failed to load reports.

                        <br><br>

                        ${escapeHtml(
                            error.message
                        )}

                    </td>

                </tr>

            `;

        }

    }


    /* =====================================================
       STATISTICS
    ===================================================== */

    function updateStatistics() {

        const total =
            allReports.length;


        const completed =
            allReports.filter(
                report => {

                    const status =
                        normalizeStatus(
                            report.status
                        );

                    return (
                        status === "Approved" ||
                        status === "Completed"
                    );

                }
            ).length;


        const submitted =
            allReports.filter(
                report =>
                    normalizeStatus(
                        report.status
                    ) === "Submitted"
            ).length;


        const returned =
            allReports.filter(
                report =>
                    normalizeStatus(
                        report.status
                    ) === "Returned"
            ).length;


        let totalDowntime = 0;

        let downtimeCount = 0;


        allReports.forEach(
            report => {

                const downtime =
                    Number(
                        report.total_downtime_h ||
                        report.downtime_h ||
                        report.totalDowntime ||
                        0
                    );


                if (
                    !Number.isNaN(downtime) &&
                    downtime > 0
                ) {

                    totalDowntime +=
                        downtime;

                    downtimeCount++;

                }

            }
        );


        const average =
            downtimeCount
                ? totalDowntime /
                  downtimeCount
                : 0;


        setText(
            "totalReports",
            total
        );


        setText(
            "completedReports",
            completed
        );


        setText(
            "inProgressReports",
            submitted
        );


        setText(
            "pendingReports",
            submitted
        );


        setText(
            "rejectedReports",
            returned
        );


        setText(
            "averageDowntime",
            average.toFixed(2)
        );

    }


    /* =====================================================
       FILTER
    ===================================================== */

    function applyFilters() {

        const search =
            (
                globalSearch?.value ||
                ""
            )
                .trim()
                .toLowerCase();


        const from =
            dateFrom?.value || "";


        const to =
            dateTo?.value || "";


        filteredReports =
            allReports.filter(
                report => {

                    const technician =
                        String(
                            report.technician_id ||
                            report.technician ||
                            report.username ||
                            ""
                        )
                            .toLowerCase();


                    const reportNumber =
                        String(
                            report.report_id ||
                            report.id ||
                            ""
                        )
                            .toLowerCase();


                    const plant =
                        String(
                            report.plant ||
                            report.plant_line ||
                            ""
                        )
                            .toLowerCase();


                    const searchMatch =
                        !search ||
                        technician.includes(
                            search
                        ) ||
                        reportNumber.includes(
                            search
                        ) ||
                        plant.includes(
                            search
                        );


                    const status =
                        normalizeStatus(
                            report.status
                        );


                    let statusMatch = true;


                    if (
                        activeStatus !==
                        "all"
                    ) {

                        if (
                            activeStatus ===
                            "mine"
                        ) {

                            const currentUser =
                                getCurrentUsername();


                            statusMatch =
                                technician ===
                                currentUser
                                    .toLowerCase();

                        } else {

                            statusMatch =
                                status ===
                                activeStatus;

                        }

                    }


                    const reportDate =
                        getReportDate(
                            report
                        );


                    let dateMatch =
                        true;


                    if (from) {

                        dateMatch =
                            reportDate >=
                            from;

                    }


                    if (
                        to &&
                        dateMatch
                    ) {

                        dateMatch =
                            reportDate <=
                            to;

                    }


                    return (
                        searchMatch &&
                        statusMatch &&
                        dateMatch
                    );

                }
            );


        currentPage = 1;

        renderTable();

    }


    /* =====================================================
       RENDER TABLE
    ===================================================== */

    function renderTable() {

        const start =
            (
                currentPage - 1
            ) *
            rowsPerPage;


        const end =
            start +
            rowsPerPage;


        const pageReports =
            filteredReports.slice(
                start,
                end
            );


        if (
            pageReports.length === 0
        ) {

            tableBody.innerHTML = `

                <tr>

                    <td
                        colspan="11"
                        class="loading-cell"
                    >
                        No reports found.
                    </td>

                </tr>

            `;

        } else {

            tableBody.innerHTML =
                pageReports
                    .map(
                        (
                            report,
                            index
                        ) =>
                            renderReportRow(
                                report,
                                start + index
                            )
                    )
                    .join("");

        }


        updatePagination();

    }


    /* =====================================================
       REPORT ROW
    ===================================================== */

    function renderReportRow(
        report,
        index
    ) {

        const reportId =
            report.report_id ||
            report.id ||
            `REPORT-${index + 1}`;


        const reportDate =
            formatDate(
                report.report_date ||
                report.date
            );


        const shift =
            report.shift ||
            "-";


        const technician =
            report.technician_id ||
            report.technician ||
            report.username ||
            "-";


        const plant =
            report.plant ||
            report.plant_line ||
            "Plant / Line";


        const workOrders =
            report.work_orders_count ||
            report.work_order_count ||
            countWorkOrders(
                report
            );


        const status =
            normalizeStatus(
                report.status
            );


        const downtime =
            getDowntime(
                report
            );


        const submittedOn =
            formatDateTime(
                report.submitted_at ||
                report.submitted_on ||
                report.created_at
            );


        return `

            <tr
                data-report-id="${escapeHtml(
                    String(reportId)
                )}"
            >

                <td>

                    <input
                        type="checkbox"
                        class="report-checkbox"
                    >

                </td>


                <td>

                    <strong>
                        ${escapeHtml(
                            String(reportId)
                        )}
                    </strong>

                </td>


                <td>
                    ${escapeHtml(
                        reportDate
                    )}
                </td>


                <td>

                    ${renderShift(
                        shift
                    )}

                </td>


                <td>

                    ${escapeHtml(
                        technician
                    )}

                </td>


                <td>

                    ${escapeHtml(
                        plant
                    )}

                </td>


                <td>

                    ${escapeHtml(
                        String(workOrders)
                    )}

                </td>


                <td>

                    ${renderStatus(
                        status
                    )}

                </td>


                <td>

                    ${downtime.toFixed(2)}

                </td>


                <td>

                    ${escapeHtml(
                        submittedOn
                    )}

                </td>


                <td>

                    <div
                        class="action-buttons"
                    >

                        <button
                            class="view-report-button"
                            type="button"
                            data-action="view"
                            data-report-id="${escapeHtml(
                                String(reportId)
                            )}"
                            title="View Report"
                        >
                            ◉
                        </button>


                        <button
                            class="more-button"
                            type="button"
                            data-action="more"
                            data-report-id="${escapeHtml(
                                String(reportId)
                            )}"
                            title="More"
                        >
                            ⋮
                        </button>

                    </div>

                </td>

            </tr>

        `;

    }


    /* =====================================================
       STATUS
    ===================================================== */

    function normalizeStatus(
        status
    ) {

        if (!status) {
            return "Draft";
        }


        const value =
            String(status)
                .trim()
                .toLowerCase();


        if (
            value ===
            "submitted"
        ) {
            return "Submitted";
        }


        if (
            value ===
            "approved"
        ) {
            return "Approved";
        }


        if (
            value ===
            "completed"
        ) {
            return "Completed";
        }


        if (
            value ===
            "returned" ||
            value ===
            "rejected"
        ) {
            return "Returned";
        }


        if (
            value.includes(
                "progress"
            )
        ) {
            return "In Progress";
        }


        return "Draft";

    }


    function renderStatus(
        status
    ) {

        let css =
            "status-draft";


        if (
            status ===
            "Submitted"
        ) {

            css =
                "status-submitted";

        }


        if (
            status ===
            "Approved" ||
            status ===
            "Completed"
        ) {

            css =
                "status-approved";

        }


        if (
            status ===
            "In Progress"
        ) {

            css =
                "status-in-progress";

        }


        if (
            status ===
            "Returned"
        ) {

            css =
                "status-returned";

        }


        return `

            <span
                class="status-badge ${css}"
            >
                ${escapeHtml(status)}
            </span>

        `;

    }


    /* =====================================================
       SHIFT
    ===================================================== */

    function renderShift(
        shift
    ) {

        const value =
            String(
                shift || "-"
            );


        let className = "";


        if (
            value
                .toLowerCase()
                .includes("even")
        ) {

            className =
                "evening";

        }


        if (
            value
                .toLowerCase()
                .includes("night")
        ) {

            className =
                "night";

        }


        let letter =
            value.charAt(0)
                .toUpperCase();


        if (
            value
                .toLowerCase()
                .includes("morning")
        ) {

            letter = "A";

        }


        if (
            value
                .toLowerCase()
                .includes("evening")
        ) {

            letter = "B";

        }


        if (
            value
                .toLowerCase()
                .includes("night")
        ) {

            letter = "C";

        }


        return `

            <span
                class="shift-badge ${className}"
                title="${escapeHtml(value)}"
            >
                ${escapeHtml(letter)}
            </span>

        `;

    }


    /* =====================================================
       VIEW REPORT
    ===================================================== */

    function showReportDetails(
        report
    ) {

        const reportId =
            report.report_id ||
            report.id ||
            "-";


        const status =
            normalizeStatus(
                report.status
            );


        const date =
            formatDate(
                report.report_date ||
                report.date
            );


        const shift =
            report.shift ||
            "-";


        const technician =
            report.technician_id ||
            report.technician ||
            report.username ||
            "-";


        const plant =
            report.plant ||
            report.plant_line ||
            "Plant / Line";


        const downtime =
            getDowntime(
                report
            );


        const workOrders =
            countWorkOrders(
                report
            );


        const submitted =
            formatDateTime(
                report.submitted_at ||
                report.submitted_on ||
                report.created_at
            );


        const notes =
            report.notes ||
            report.general_notes ||
            report.comments ||
            "No notes available.";


        detailsContent.innerHTML = `

            <div
                class="detail-report-number"
            >

                <strong>
                    ${escapeHtml(
                        String(reportId)
                    )}
                </strong>

                ${renderStatus(
                    status
                )}

            </div>


            <div class="detail-list">


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Date
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${escapeHtml(date)}
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Shift
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${escapeHtml(shift)}
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Technician
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${escapeHtml(
                            technician
                        )}
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Plant / Line
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${escapeHtml(
                            plant
                        )}
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Work Orders
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${workOrders}
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Total Downtime
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${downtime.toFixed(2)}
                        hrs
                    </span>

                </div>


                <div class="detail-row">

                    <span
                        class="detail-label"
                    >
                        Submitted On
                    </span>

                    <span
                        class="detail-value"
                    >
                        ${escapeHtml(
                            submitted
                        )}
                    </span>

                </div>

            </div>


            <div class="detail-notes">

                <div
                    class="detail-notes-title"
                >
                    Notes
                </div>

                <div
                    class="detail-notes-text"
                >
                    ${escapeHtml(
                        notes
                    )}
                </div>

            </div>


            <button
                class="detail-action"
                type="button"
                data-full-report="${escapeHtml(
                    String(reportId)
                )}"
            >
                ◉ View Full Report
            </button>

        `;

    }


    /* =====================================================
       PAGINATION
    ===================================================== */

    function updatePagination() {

        const total =
            filteredReports.length;


        const totalPages =
            Math.max(
                1,
                Math.ceil(
                    total /
                    rowsPerPage
                )
            );


        if (
            currentPage >
            totalPages
        ) {

            currentPage =
                totalPages;

        }


        const start =
            total === 0
                ? 0
                : (
                    (
                        currentPage - 1
                    ) *
                    rowsPerPage
                ) + 1;


        const end =
            Math.min(
                currentPage *
                rowsPerPage,
                total
            );


        paginationInfo.textContent =
            `Showing ${start} to ${end} of ${total} entries`;


        paginationControls.innerHTML =
            "";


        if (
            currentPage > 1
        ) {

            paginationControls.appendChild(
                createPageButton(
                    "‹",
                    currentPage - 1
                )
            );

        }


        for (
            let page = 1;
            page <= totalPages;
            page++
        ) {

            if (
                totalPages > 7 &&
                page > 5 &&
                page < totalPages
            ) {

                if (
                    page === 6
                ) {

                    const dots =
                        document.createElement(
                            "span"
                        );

                    dots.textContent =
                        "...";

                    dots.style.padding =
                        "0 5px";

                    paginationControls.appendChild(
                        dots
                    );

                }

                continue;

            }


            paginationControls.appendChild(
                createPageButton(
                    String(page),
                    page,
                    page === currentPage
                )
            );

        }


        if (
            currentPage <
            totalPages
        ) {

            paginationControls.appendChild(
                createPageButton(
                    "›",
                    currentPage + 1
                )
            );

        }

    }


    function createPageButton(
        text,
        page,
        active = false
    ) {

        const button =
            document.createElement(
                "button"
            );


        button.type =
            "button";


        button.className =
            `page-button ${
                active
                    ? "active"
                    : ""
            }`;


        button.textContent =
            text;


        button.addEventListener(
            "click",
            () => {

                currentPage =
                    page;

                renderTable();

            }
        );


        return button;

    }


    /* =====================================================
       EVENTS
    ===================================================== */

    globalSearch?.addEventListener(
        "input",
        applyFilters
    );


    dateFrom?.addEventListener(
        "change",
        applyFilters
    );


    dateTo?.addEventListener(
        "change",
        applyFilters
    );


    rowsPerPageSelect?.addEventListener(
        "change",
        () => {

            rowsPerPage =
                Number(
                    rowsPerPageSelect.value
                );

            currentPage = 1;

            renderTable();

        }
    );


    document
        .querySelectorAll(
            ".report-tab"
        )
        .forEach(
            tab => {

                tab.addEventListener(
                    "click",
                    () => {

                        document
                            .querySelectorAll(
                                ".report-tab"
                            )
                            .forEach(
                                item =>
                                    item.classList.remove(
                                        "active"
                                    )
                            );


                        tab.classList.add(
                            "active"
                        );


                        activeStatus =
                            tab.dataset.status;


                        applyFilters();

                    }
                );

            }
        );


    tableBody.addEventListener(
        "click",
        event => {

            const button =
                event.target.closest(
                    "[data-action]"
                );


            if (!button) {
                return;
            }


            const reportId =
                button.dataset.reportId;


            const report =
                allReports.find(
                    item =>
                        String(
                            item.report_id ||
                            item.id
                        ) ===
                        String(reportId)
                );


            if (!report) {
                return;
            }


            if (
                button.dataset.action ===
                "view"
            ) {

                showReportDetails(
                    report
                );

            }


            if (
                button.dataset.action ===
                "more"
            ) {

                showReportDetails(
                    report
                );

            }

        }
    );


    closeDetails?.addEventListener(
        "click",
        () => {

            detailsContent.innerHTML = `

                <div class="empty-details">

                    <div>
                        ▤
                    </div>

                    <p>
                        Select a report to view its details.
                    </p>

                </div>

            `;

        }
    );


    selectAll?.addEventListener(
        "change",
        () => {

            document
                .querySelectorAll(
                    ".report-checkbox"
                )
                .forEach(
                    checkbox => {

                        checkbox.checked =
                            selectAll.checked;

                    }
                );

        }
    );


    /* =====================================================
       NEW REPORT BUTTON
       
       IMPORTANT:
       Technician clicks this button
       → Technician Daily Report Form
    ===================================================== */

    newReportButton?.addEventListener(
        "click",
        () => {

            window.location.href =
                "daily-report.html";

        }
    );


    /* =====================================================
       FILTER BUTTON
    ===================================================== */

    document
        .getElementById(
            "filterButton"
        )
        ?.addEventListener(
            "click",
            () => {

                globalSearch?.focus();

            }
        );


    /* =====================================================
       HELPERS
    ===================================================== */

    function getCurrentUsername() {

        try {

            const user =
                JSON.parse(
                    localStorage.getItem(
                        "user"
                    ) || "{}"
                );


            return String(
                user.username ||
                user.technician_id ||
                user.user?.username ||
                ""
            );

        } catch (_) {

            return "";

        }

    }


    function getReportDate(
        report
    ) {

        return String(
            report.report_date ||
            report.date ||
            ""
        )
            .substring(0, 10);

    }


    function getDowntime(
        report
    ) {

        if (
            report.total_downtime_h != null
        ) {

            return Number(
                report.total_downtime_h
            ) || 0;

        }


        if (
            report.downtime_h != null
        ) {

            return Number(
                report.downtime_h
            ) || 0;

        }


        if (
            Array.isArray(
                report.items
            )
        ) {

            return report.items.reduce(
                (
                    total,
                    item
                ) => {

                    return total +
                        (
                            Number(
                                item.downtime_h
                            ) || 0
                        );

                },
                0
            );

        }


        return 0;

    }


    function countWorkOrders(
        report
    ) {

        if (
            report.work_orders_count != null
        ) {

            return Number(
                report.work_orders_count
            ) || 0;

        }


        if (
            report.work_order_count != null
        ) {

            return Number(
                report.work_order_count
            ) || 0;

        }


        if (
            Array.isArray(
                report.items
            )
        ) {

            return report.items.filter(
                item =>
                    item.wo_id
            ).length;

        }


        return 0;

    }


    function formatDate(
        value
    ) {

        if (!value) {
            return "-";
        }


        const date =
            new Date(value);


        if (
            Number.isNaN(
                date.getTime()
            )
        ) {

            return String(value);

        }


        return date.toLocaleDateString(
            "en-GB"
        );

    }


    function formatDateTime(
        value
    ) {

        if (!value) {
            return "-";
        }


        const date =
            new Date(value);


        if (
            Number.isNaN(
                date.getTime()
            )
        ) {

            return String(value);

        }


        return date.toLocaleDateString(
            "en-GB"
        ) +
        " " +
        date.toLocaleTimeString(
            "en-US",
            {
                hour: "2-digit",
                minute: "2-digit"
            }
        );

    }


    function setText(
        id,
        value
    ) {

        const element =
            document.getElementById(
                id
            );


        if (element) {

            element.textContent =
                value;

        }

    }


    function escapeHtml(
        value
    ) {

        return String(
            value ?? ""
        )
            .replaceAll(
                "&",
                "&amp;"
            )
            .replaceAll(
                "<",
                "&lt;"
            )
            .replaceAll(
                ">",
                "&gt;"
            )
            .replaceAll(
                '"',
                "&quot;"
            )
            .replaceAll(
                "'",
                "&#039;"
            );

    }


    /* =====================================================
       USER INFO
    ===================================================== */

    try {

        const user =
            JSON.parse(
                localStorage.getItem(
                    "user"
                ) || "{}"
            );


        const username =
            user.username ||
            user.technician_id ||
            user.user?.username ||
            "User";


        const role =
            user.role ||
            user.user?.role ||
            "Engineer";


        setText(
            "sidebarUsername",
            username
        );


        setText(
            "sidebarRole",
            role
                .replaceAll(
                    "_",
                    " "
                )
        );

    } catch (_) {

        // Ignore invalid local session.

    }


    /* =====================================================
       START
    ===================================================== */

    loadReports();

});