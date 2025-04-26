const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = 3000;
const GOOGLE_API_KEY = "AIzaSyCC98qBzRglCXE_fOxPqFymJRV5kY8b-7M";
const USER_LOCATION = "Pilotystraße 29, 90408 Nürnberg";

app.get("/transit", async (req, res) => {
    const ziel = req.query.ziel;
    if (!ziel) return res.status(400).json({ error: "ziel fehlt" });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(USER_LOCATION)}&destinations=${encodeURIComponent(ziel)}&mode=transit&key=${GOOGLE_API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        const status = data.rows[0].elements[0].status;
        const duration = data.rows[0].elements[0].duration.value;
        res.json({ status, duration });
    } catch (err) {
        res.status(500).json({ error: "Fehler bei Anfrage", details: err.toString() });
    }
});

app.listen(PORT, () => {
    console.log(`Proxy läuft auf http://localhost:${PORT}`);
});