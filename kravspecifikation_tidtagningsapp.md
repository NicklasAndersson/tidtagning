# Kravspecifikation: Tidtagningsapp för mindre lopp

## 1. Bakgrund och Syfte
Syftet med projektet är att utveckla en modern, webbaserad tidtagningsapplikation för mindre lopp. Systemet ska vara robust i miljöer med dålig mobiltäckning (exempelvis skogsmiljö) och ha ett starkt fokus på enkelhet för funktionärer. Dessutom ska applikationen tillåta publik att "crowdsourca" rapportering genom att skanna löparnas QR-koder. 

Systemet är designat som en "single-tenant"-lösning: systemet hanterar exakt ett *aktivt* lopp i taget. Flera aktiva lopp samtidigt hanteras genom separata instanser/subdomäner (t.ex. `lopp1.app.se`, `lopp2.app.se`). Alla deltagare i loppet startar samtidigt (Gemensam mass-start) vilket håller tidtagningslogiken ren och enkel. När ett lopp är färdigt arkiveras resultaten som en statisk webbsida, varpå databasen nollställs.

---

## 2. Teknisk Arkitektur
Plattformen bygger på en serverlös "Edge"-arkitektur via Cloudflare för hög prestanda och låg driftkostnad.

*   **Frontend (Klient):** Progressive Web App (PWA) byggd i React, Vue eller Svelte.
*   **Backend / API:** Cloudflare Workers (Hono).
*   **Databas (Kritisk data):** Cloudflare D1 (Serverlös SQLite).
*   **Cache / Livedata:** Cloudflare KV för snabba resultatlistor (hanterar bekvämt hundratals samtidiga åskådare).
*   **Filhantering:** Cloudflare R2 för uppladdning av GPX-filer (bansträckning) samt lagring av det statiska HTML-arkivet.

---

## 3. Användarroller
1.  **Arrangör (Admin):** Loggar in i systemet med ett gemensamt användarnamn och lösenord. Hanterar hela loppets livscykel: deltagare, stationer, QR-koder och arkivering.
2.  **Funktionär (Skanner):** Loggar in i appen (t.ex. genom att skanna en funktionärs-QR), väljer/tilldelas vilken station de bemannar och skannar därefter löpare "offline first".
3.  **Gäst / Publik (Oinloggad):** Skannar löpare med sin vanliga mobilkamera, lämnar kommentarer och delar sin plats (frivilligt).

---

## 4. Funktionella Krav

### 4.1. Tävlingsadministration (Bakom inloggning)
*   **Gemensam Start (Mass-start):** Arrangören ställer in en exakt starttid för loppet. Alla klasser och deltagare startar på denna tid. Innan start visas en publik nedräkning för både publik och löpare.
*   **Deltagarhantering & QR-koppling:** Lägg till deltagare och tilldela klass (t.ex. Herr/Dam). Arrangören ska kunna återanvända fysiska nummerlappar/QR-koder genom att i admin-vyn koppla en befintlig QR-kod till en ny deltagare.
*   **Stationer & Funktionärer:** Skapa stationer ("Checkpoint" eller "Mål"). Skapa även funktionärsinloggningar/QR-koder kopplade till dessa stationer.

### 4.2. Officiell Tidtagning (Funktionär)
*   **Extremt snabb Kameraskanning:** PWA:n ska använda modern teknik (native BarcodeDetector API alt. WebAssembly-fallback) och vara optimerad för att snabbt läsa QR-koder i rörelse. "Error Correction" sätts till L (Low) vid utskrift för snabbare avläsning.
*   **Manuell inmatning:** Fallback via stort numeriskt tangentbord på skärmen.
*   **Hantering av Oregistrerade QR-koder (Inga felmeddelanden):** Om en okänd QR-kod skannas ska skanningen *ändå* gå igenom och en tid sparas. Systemet skapar en rad i databasen för "Okänd deltagare", så att arrangören i efterhand kan namnge/koppla koden i dashboarden.
*   **Första tiden gäller:** Om en löpare skannas flera gånger på samma station sparas enbart den första tidstämpeln.
*   **Mjuk GPS-kontroll ("Trust but verify"):** Funktionärens app begär GPS-åtkomst. Om tillstånd ges sparas funktionärens position vid varje skanning. Saknas mottagning/tillstånd går skanningen ändå igenom.

### 4.3. Gäst-skanning (Crowdsourcing)
*   När publik (utan app) skannar samma QR-kod, öppnas en webbsida för just den löparen.
*   Tid och plats (via webbläsarens GPS-fråga) loggas oinloggat.
*   Gästen kan skriva en hejarop/kommentar. Dessa lagras separat och påverkar inte den officiella resultatlistan.

### 4.4. Arkivering och Systemåterställning
*   **Komplett Statisk Export:** Efter avslutat lopp klickar arrangören "Arkivera". Systemet bakar ihop *alla* tider, publikkommentarer, mellantider, kartdata och UI-komponenter till statiska HTML-filer.
*   **Lagring & Nollställning:** Arkivet publiceras på en läsbar länk på Cloudflare R2 för evig, gratis lagring. Därefter raderas all aktiv tävlingsdata ur D1-databasen och systemet är redo för nästa lopp.

---

## 5. Gränssnitt och Vyer

Systemet ska bestå av följande tydliga vyer (sidor):

### 5.1. Publika Vyer (Gäster och Deltagare)
*   **Översiktskarta (Alla deltagare):** En stor karta som visar GPX-spåret för loppet. Här ritas alla aktiva löpare ut live baserat på deras senaste kända position (officiell checkpoint eller gästskanning).
*   **Resultatlista:** En lista över alla deltagare, sorterbar på klass. Visar aktuella mellantider från checkpoints samt sluttid (måltid) om de gått i mål. Ovanför listan visas nedräkning till start om loppet inte börjat.
*   **Deltagarsida (Profil):** En specifik vy för en enskild löpare. Visar löparens namn, klass, en personlig karta med deras individuella framfart, samt en kronologisk tidslinje som blandar officiella mellantider med gästernas kommentarer och hejarop.

### 5.2. Admin-vyer (Inloggad Arrangör)
*   **Admin: Deltagare:** Sida för att skapa deltagare, byta klass, samt koppla fysiska QR-koder till specifika namn (inklusive att identifiera "Okända deltagare" som skannats under loppet).
*   **Admin: Funktionärer & Stationer:** Sida för att skapa checkpoints och mål, samt skapa funktionärs-accesser för dessa.
*   **Admin: Utskrift:** En dedikerad vy anpassad för skrivare. Här genereras och skrivs QR-koder ut i rätt format, både för löparnas nummerlappar och för funktionärernas inloggningskort.

---

## 6. Icke-funktionella krav

### 6.1. Offline-first och Tålighet
*   **Lokal Lagring:** All funktionärsskanning sparas *omedelbart* i telefonens `IndexedDB`. Appen inväntar inte serverns svar, utan ger direkt grön visuell/auditiv feedback.
*   **Bakgrundssynk:** En process skickar datan (batch) till Cloudflare så fort mobilen får nätverk. Tiden som sparas är alltid tiden från enhetens klocka i skanningsögonblicket.

### 6.2. Prestanda
*   Live-resultat och publika profiler ska klara av att laddas av **hundratals åskådare** samtidigt utan att märkbart belasta databasen (tack vare Cloudflare KV).

---

## 7. Datamodell (Förenklad för Cloudflare D1)

*   **Deltagare:** `id`, `startnummer`, `namn`, `klass`, `qr_uuid` (Tillåter att namn fylls i i efterhand för "Okända").
*   **Stationer:** `id`, `namn`, `typ` (Mål/Checkpoint), `latitud`, `longitud`, `distans_km`.
*   **Passeringar (Officiella):** `id`, `deltagare_id`, `station_id`, `tidstampel` (mobilens tid), `skannad_av`, `skannad_lat`, `skannad_long`. *(Har UNIQUE-constraint på deltagare+station).*
*   **Gast_Rapporter:** `id`, `deltagare_id`, `tidstampel`, `kommentar`, `latitud`, `longitud`.

---

## 8. Implementationsplan (Fas 1: Proof of Concept)

För att snabbt validera projektets kärnvärde byggs en isolerad PoC i första steget:
1.  **QR-Generering:** Skript för att generera och skriva ut URL-baserade QR-koder med "Low Error Correction" (för maximal skanningshastighet).
2.  **Skanner-PWA (Frontend):** En webb-vy som nyttjar snabbast möjliga skanningsbibliotek (WebAssembly/BarcodeDetector) centrerat till en "skanner-ruta" i UI:t.
3.  **Lokal Lagring:** Implementera IndexedDB för att omedelbart (blixtsnabbt) registrera tid och visa grön skärm vid en identifierad loppet-URL. 

*Mål med Fas 1 är att utvärdera om funktionärer kan skanna löpare i full fart ute i fält lika effektivt som med dyr specialutrustning.*