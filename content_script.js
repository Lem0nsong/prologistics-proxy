function waitForTableAndRun() {
    const observer = new MutationObserver(() => {
        const table = document.querySelector("table");
        if (table && !table.dataset.oevDone) {
            table.dataset.oevDone = "true";
            addTravelTimeColumn();
            observer.disconnect();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

const userLocation = "Pilotystraße 29, 90408 Nürnberg";

async function getTransitTime(destination) {
    const url = `http://localhost:3000/transit?ziel=${encodeURIComponent(destination)}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === "OK") {
            return data.duration / 60;
        } else {
            return null;
        }
    } catch (error) {
        console.error("Fehler bei Proxy-Abfrage:", error);
        return null;
    }
}

async function addTravelTimeColumn() {
    const table = document.querySelector("table");
    if (!table) return;

    const headerRow = table.querySelector("thead tr");
    const newHeader = document.createElement("th");
    newHeader.textContent = "ÖPNV-Fahrzeit";
    newHeader.style.cursor = "pointer";
    headerRow.appendChild(newHeader);

    const rows = table.querySelectorAll("tbody tr");

    for (const row of rows) {
        const startCell = row.cells[1];
        const zielCell = row.cells[2];

        const startAddress = startCell ? startCell.innerText.trim() : "";
        const zielAddress = zielCell ? zielCell.innerText.trim() : "";

        const [startTime, zielTime] = await Promise.all([
            getTransitTime(startAddress),
            getTransitTime(zielAddress)
        ]);

        let shortestTime = "-";
        if (startTime !== null && zielTime !== null) {
            shortestTime = Math.round(Math.min(startTime, zielTime)) + " Min.";
        } else if (startTime !== null) {
            shortestTime = Math.round(startTime) + " Min.";
        } else if (zielTime !== null) {
            shortestTime = Math.round(zielTime) + " Min.";
        }

        const newCell = document.createElement("td");
        newCell.textContent = shortestTime;
        row.appendChild(newCell);
    }
}

waitForTableAndRun();