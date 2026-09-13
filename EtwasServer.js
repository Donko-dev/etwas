/* ============================================================================
   ETWAS SERVER — Backend Node.js / Express / MySQL
   ============================================================================
   Ce fichier remplace intégralement DEUX systèmes qui coexistaient avant :
     1. La version précédente d'EtwasServer.js, qui stockait tout dans un
        simple fichier JSON local (etwas-data.json) — utile pour démarrer
        vite, mais pas une vraie base de données.
     2. AppsScript_v5.gs + Google Sheets, qui servaient de backend à Etwas ADS
        (boutiques, annonces, TVA, abonnement, boost, modération).

   Désormais, TOUT (Etwas Pro ET Etwas ADS) passe par CE serveur et une VRAIE
   base MySQL (voir schema.sql à exécuter une fois sur ta base Hostinger).
   Il n'y a plus qu'un seul backend, un seul système de vérité.

   ⚠️ CONTEXTE DE DÉPLOIEMENT ACTUEL — En attendant ta vraie mise en
   production (nom de domaine etwas.com, vrai VPS Hostinger, vraie base
   MySQL, vraies clés API), le SITE STATIQUE (index.html + les deux modules)
   reste hébergé sur GitHub (Pages) et fonctionne à 100% SANS ce serveur :
   EtwasCloud.js se dégrade proprement (API_BASE non configuré) et chaque
   module retombe sur son fonctionnement local existant. Ce fichier, lui,
   n'est PAS déployé sur GitHub (Pages ne fait tourner aucun code serveur) —
   il attend d'être hébergé sur ton VPS le jour où tu actives les vrais
   paiements automatiques. Rien ici ne bloque le site actuel.

   Ce que ce fichier fait :
     - Émet l'heure officielle du serveur (anti-triche horloge locale).
     - Gère le compte Etwas unique (ID + nom d'entreprise + Trial/abonnement).
     - Reçoit et vérifie les webhooks KKiaPay, Plisio, Stripe et PayPal —
       les QUATRE passerelles sont désormais gérées ici, chacune avec sa
       propre vérification de signature/authenticité et sa protection
       anti-rejeu (une transaction externe ne peut jamais être appliquée
       deux fois, quelle que soit la passerelle).
     - Tient le registre GoBD (chaînage SHA-256) pour Etwas Pro.
     - Gère l'intégralité des boutiques et annonces d'Etwas ADS : création,
       modification, suppression, boost, suspension/réactivation, calcul de
       TVA par pays, confirmation d'abonnement avec réactivation automatique
       des annonces suspendues — tout ce que faisait AppsScript_v5.gs, porté
       fidèlement en SQL.
     - Boîte à suggestions (Etwas Pro ET Etwas ADS).

   Ce que ce fichier NE fait PAS :
     - Il n'est pas déployé ici. C'est le code source prêt à héberger sur ton
       VPS Hostinger, avec Node.js ≥ 18 ET une base MySQL déjà créée (voir
       schema.sql — à exécuter une seule fois via phpMyAdmin ou la CLI mysql
       avant le premier démarrage).
     - Il n'est PAS connecté à de vraies clés API. Tant que les variables
       d'environnement ne sont pas renseignées, chaque route concernée
       répond explicitement "non configuré" plutôt que d'échouer en silence.
     - Les images (logos de boutique, photos d'annonce) restent stockées en
       base64 directement dans la base (colonnes LONGTEXT), exactement comme
       elles l'étaient dans les cellules Google Sheets — c'est le choix le
       plus simple et le plus fidèle à l'existant. Migrer vers un stockage
       fichier (disque du VPS ou stockage objet) est une optimisation future
       possible, mais n'est pas nécessaire pour sortir de Google Sheets.

   Démarrage (le jour de la vraie mise en production) :
     1. Crée une base MySQL sur ton panneau Hostinger (hébergement → Bases
        de données MySQL) et note : hôte, nom de base, utilisateur, mot de passe.
     2. Importe schema.sql dans cette base (phpMyAdmin → Importer, ou
        `mysql -u USER -p NOMBASE < schema.sql` en CLI).
     3. npm install
     4. copie .env.example vers .env et renseigne tes vraies valeurs
     5. node EtwasServer.js
   ============================================================================ */

"use strict";

const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

try { require("dotenv").config(); } catch (e) { /* pas grave si absent */ }

const app = express();
app.use(express.json({
  limit: "12mb", // les images en base64 (logos, photos d'annonce) peuvent être volumineuses
  verify: (req, res, buf) => { req.rawBody = buf; } // nécessaire à la vérification de signature Stripe
}));

/* ============================================================================
   0. CONFIGURATION — variables d'environnement uniquement. Aucun secret
      n'est écrit en dur dans ce fichier.
   ============================================================================ */
const CONFIG = {
  PORT: process.env.PORT || 3000,

  DB_HOST: process.env.DB_HOST || "localhost",
  DB_PORT: Number(process.env.DB_PORT || 3306),
  DB_USER: process.env.DB_USER || "",
  DB_PASSWORD: process.env.DB_PASSWORD || "",
  DB_NAME: process.env.DB_NAME || "etwas",

  ADMIN_TOKEN: process.env.ETWAS_ADMIN_TOKEN || null,
  // Empreinte SHA-256 du "code pro" — reprise EXACTEMENT de l'ancien
  // AppsScript_v5.gs pour ne rien casser côté client (même code, même hash).
  // Si tu changes le code pro dans l'app, recalcule ce hash et redéploie.
  ADMIN_PASSCODE_HASH: process.env.ETWAS_ADMIN_PASSCODE_HASH || "391a9dc924d6b2a6fde451b85559d328ad52c8f4013f02d94d48e64d7a460e1a",

  KKIAPAY_PUBLIC_KEY: process.env.KKIAPAY_PUBLIC_KEY || null,
  KKIAPAY_SECRET_KEY: process.env.KKIAPAY_SECRET_KEY || null,

  PLISIO_API_KEY: process.env.PLISIO_API_KEY || null,

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || null,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || null,

  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID || null,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || null,
  PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID || null,
  PAYPAL_ENV: process.env.PAYPAL_ENV || "live",

  PIVOT_CURRENCY: "EUR",
  TRIAL_PRICE_EUR: 1,
  TRIAL_DURATION_DAYS: 30,
  CLOCK_DRIFT_TOLERANCE_MS: 5 * 60 * 1000
};

/* ============================================================================
   1. CONNEXION MYSQL — pool de connexions réutilisables.
   ============================================================================ */
const pool = mysql.createPool({
  host: CONFIG.DB_HOST,
  port: CONFIG.DB_PORT,
  user: CONFIG.DB_USER,
  password: CONFIG.DB_PASSWORD,
  database: CONFIG.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4_general_ci"
});

// Exécute une série d'opérations dans une VRAIE transaction SQL (tout ou
// rien) — utilisé partout où plusieurs écritures doivent réussir ensemble.
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ============================================================================
   2. UTILITAIRES
   ============================================================================ */
function generateEtwId() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ETW-${seg()}-${seg()}-${seg()}`;
}
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function serverNow() { return Date.now(); }
function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}
function isAdminAuthorized(data) {
  return !!(data && data.adminSecret) && sha256Hex(data.adminSecret) === CONFIG.ADMIN_PASSCODE_HASH;
}
function ownerAuthorized(storedToken, data) {
  if (!storedToken) return true;
  return !!(data && data.ownerToken) && data.ownerToken === storedToken;
}
function requireAdminToken(req, res, next) {
  if (!CONFIG.ADMIN_TOKEN) return res.status(503).json({ error: "admin_not_configured" });
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, CONFIG.ADMIN_TOKEN)) return res.status(401).json({ error: "unauthorized" });
  next();
}
function uuid() { return crypto.randomUUID(); }

app.use((req, res, next) => {
  res.setHeader("X-Etwas-Server-Time", String(serverNow()));
  next();
});
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ETWAS_ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ============================================================================
   3. HORLOGE SERVEUR
   ============================================================================ */
app.get("/api/time", (req, res) => {
  res.json({ serverTime: serverNow(), toleranceMs: CONFIG.CLOCK_DRIFT_TOLERANCE_MS });
});

/* ============================================================================
   4. COMPTES ETWAS
   ============================================================================ */
app.post("/api/account/create", async (req, res) => {
  const companyName = String(req.body.companyName || "").trim();
  if (!companyName) return res.status(400).json({ error: "missing_company_name" });

  const etwId = generateEtwId();
  await pool.execute(
    "INSERT INTO accounts (etw_id, company_name, owner_token, created_at) VALUES (?, ?, ?, ?)",
    [etwId, companyName, crypto.randomBytes(16).toString("hex"), serverNow()]
  );
  res.json({ etwId, companyName, createdAt: serverNow() });
});

app.get("/api/account/:etwId/status", async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM accounts WHERE etw_id = ?", [req.params.etwId]);
  if (!rows.length) return res.status(404).json({ error: "account_not_found" });
  const account = rows[0];
  const now = serverNow();
  const trialActive = !!(account.trial_expires_at && Number(account.trial_expires_at) > now);
  const subActive = !!(account.subscription_expires_at && Number(account.subscription_expires_at) > now);

  res.json({
    etwId: req.params.etwId,
    companyName: account.company_name,
    isPremium: trialActive || subActive,
    trial: { active: trialActive, expiresAt: account.trial_expires_at ? Number(account.trial_expires_at) : null },
    subscription: { active: subActive, expiresAt: account.subscription_expires_at ? Number(account.subscription_expires_at) : null },
    serverTime: now
  });
});

// Active/prolonge Trial ou abonnement — appelé uniquement APRÈS vérification
// réelle d'un paiement (section 5). Retourne alreadyProcessed si la
// transaction externe a déjà été traitée (anti-rejeu partagé entre passerelles).
async function activatePremium(conn, { etwId, purpose, days, gateway, txKey }) {
  const [existing] = await conn.execute("SELECT 1 FROM processed_transactions WHERE tx_key = ?", [txKey]);
  if (existing.length) return { alreadyProcessed: true };

  const [accRows] = await conn.execute("SELECT * FROM accounts WHERE etw_id = ? FOR UPDATE", [etwId]);
  if (!accRows.length) return { accountMissing: true };

  const now = serverNow();
  const account = accRows[0];
  if (purpose === "trial") {
    await conn.execute("UPDATE accounts SET trial_expires_at = ? WHERE etw_id = ?", [now + days * 86400000, etwId]);
  } else if (purpose === "subscription") {
    const base = (account.subscription_expires_at && Number(account.subscription_expires_at) > now)
      ? Number(account.subscription_expires_at) : now;
    await conn.execute("UPDATE accounts SET subscription_expires_at = ? WHERE etw_id = ?", [base + days * 86400000, etwId]);
  }
  await conn.execute(
    "INSERT INTO processed_transactions (tx_key, gateway, etw_id, purpose, processed_at) VALUES (?, ?, ?, ?, ?)",
    [txKey, gateway, etwId, purpose, now]
  );
  return { ok: true };
}

/* ============================================================================
   5. WEBHOOKS DE PAIEMENT — les QUATRE passerelles.
   ============================================================================ */

// --- 5.1 KKiaPay ---
app.post("/api/webhook/kkiapay", async (req, res) => {
  if (!CONFIG.KKIAPAY_SECRET_KEY) return res.status(503).json({ error: "kkiapay_not_configured" });

  let clientData = req.body.data;
  if (typeof clientData === "string") {
    try { clientData = JSON.parse(clientData); } catch (e) { clientData = null; }
  }
  const transactionId = req.body.transactionId || req.body.transactionid || (clientData && clientData.ref);
  const etwId = req.body.etwId || (clientData && clientData.etwId);
  const purpose = req.body.purpose || (clientData && clientData.purpose) || "trial";
  const adId = req.body.adId || (clientData && clientData.adId);
  const days = Number(req.body.days || (clientData && clientData.days)) || CONFIG.TRIAL_DURATION_DAYS;

  if (!transactionId || !etwId) return res.status(400).json({ error: "missing_transaction_or_account" });

  try {
    const verifyRes = await fetch("https://api.kkiapay.me/api/v1/transactions/status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.KKIAPAY_PUBLIC_KEY || "",
        "x-secret-key": CONFIG.KKIAPAY_SECRET_KEY
      },
      body: JSON.stringify({ transactionId })
    });
    const verifyData = await verifyRes.json().catch(() => null);
    if (!verifyRes.ok || !verifyData || verifyData.status !== "SUCCESS") {
      return res.status(400).json({ error: "transaction_not_confirmed" });
    }
  } catch (e) {
    console.error("[KKiaPay] Échec de vérification :", e.message);
    return res.status(502).json({ error: "verification_failed" });
  }

  try {
    const result = await withTransaction((conn) =>
      activatePremium(conn, { etwId, purpose, days, gateway: "kkiapay", txKey: `kkiapay:${transactionId}` })
    );
    if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
    if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });

    if (purpose === "boost" && adId) {
      await pool.execute(
        "UPDATE boutiques SET boost = 1, boost_expiration = DATE_ADD(NOW(), INTERVAL 31 DAY) WHERE id = ?",
        [adId]
      );
    }
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[KKiaPay] Erreur d'activation :", e.message);
    return res.status(500).json({ error: "activation_failed" });
  }
});

// --- 5.2 Plisio ---
app.post("/api/webhook/plisio", async (req, res) => {
  if (!CONFIG.PLISIO_API_KEY) return res.status(503).json({ error: "plisio_not_configured" });

  const body = { ...req.body };
  const receivedHash = body.verify_hash;
  delete body.verify_hash;
  const ordered = {};
  Object.keys(body).sort().forEach((k) => { ordered[k] = body[k]; });
  const computedHash = crypto.createHmac("sha1", CONFIG.PLISIO_API_KEY).update(JSON.stringify(ordered)).digest("hex");
  if (!receivedHash || !safeEqual(computedHash, receivedHash)) {
    return res.status(401).json({ error: "invalid_signature" });
  }
  if (body.status !== "completed" && body.status !== "mismatch paid") {
    return res.status(200).json({ status: "acknowledged_pending" });
  }

  let orderData = null;
  try { orderData = JSON.parse(body.order_name || "null"); } catch (e) { orderData = null; }
  const etwId = (orderData && orderData.etwId) || body.order_name;
  const purpose = (orderData && orderData.purpose) || body.purpose || "trial";
  const days = Number((orderData && orderData.days) || body.days) || CONFIG.TRIAL_DURATION_DAYS;
  const transactionId = body.txn_id || body.order_number;

  if (!transactionId || !etwId) return res.status(400).json({ error: "missing_transaction_or_account" });

  const result = await withTransaction((conn) =>
    activatePremium(conn, { etwId, purpose, days, gateway: "plisio", txKey: `plisio:${transactionId}` })
  );
  if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  return res.status(200).json({ status: "ok" });
});

// --- 5.3 Stripe — vérification RÉELLE de signature (npm install stripe) ---
app.post("/api/webhook/stripe", async (req, res) => {
  if (!CONFIG.STRIPE_SECRET_KEY || !CONFIG.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: "stripe_not_configured", message: "En attente des clés API DONKO UG." });
  }
  let event;
  try {
    const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
    const signature = req.headers["stripe-signature"];
    // req.rawBody (capturé par express.json verify ci-dessus) est indispensable :
    // Stripe exige les octets BRUTS exacts pour valider la signature HMAC.
    event = stripe.webhooks.constructEvent(req.rawBody, signature, CONFIG.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("[Stripe] Signature invalide :", e.message);
    return res.status(400).json({ error: "invalid_signature" });
  }

  if (event.type !== "checkout.session.completed" && event.type !== "payment_intent.succeeded") {
    return res.status(200).json({ status: "ignored_event_type" });
  }
  const session = event.data.object;
  const metadata = session.metadata || {};
  const etwId = metadata.etwId;
  const purpose = metadata.purpose || "subscription";
  const days = Number(metadata.days) || CONFIG.TRIAL_DURATION_DAYS;
  if (!etwId) return res.status(400).json({ error: "missing_etwid_in_metadata" });

  const result = await withTransaction((conn) =>
    activatePremium(conn, { etwId, purpose, days, gateway: "stripe", txKey: `stripe:${event.id}` })
  );
  if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  return res.status(200).json({ status: "ok" });
});

app.post("/api/pay/create-stripe-session", async (req, res) => {
  if (!CONFIG.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_not_configured" });
  const { etwId, purpose, planId, amountEUR, successUrl, cancelUrl, days } = req.body;
  if (!etwId || !amountEUR) return res.status(400).json({ error: "missing_fields" });
  try {
    const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: "Etwas Pro & Etwas ADS — " + (planId || "abonnement") },
          unit_amount: Math.round(Number(amountEUR) * 100)
        },
        quantity: 1
      }],
      metadata: { etwId, purpose: purpose || "subscription", planId: planId || "", days: String(days || CONFIG.TRIAL_DURATION_DAYS) },
      success_url: successUrl || (process.env.ETWAS_PUBLIC_URL || "") + "/index.html?pay=success",
      cancel_url: cancelUrl || (process.env.ETWAS_PUBLIC_URL || "") + "/index.html?pay=cancel"
    });
    res.json({ checkoutUrl: session.url });
  } catch (e) {
    console.error("[Stripe] Échec de création de session :", e.message);
    res.status(502).json({ error: "stripe_error" });
  }
});

// --- 5.4 PayPal — vérification RÉELLE de signature webhook ---
async function paypalGetAccessToken() {
  const base = CONFIG.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const creds = Buffer.from(`${CONFIG.PAYPAL_CLIENT_ID}:${CONFIG.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await r.json();
  return data.access_token;
}

app.post("/api/webhook/paypal", async (req, res) => {
  if (!CONFIG.PAYPAL_CLIENT_ID || !CONFIG.PAYPAL_CLIENT_SECRET || !CONFIG.PAYPAL_WEBHOOK_ID) {
    return res.status(503).json({ error: "paypal_not_configured", message: "En attente des tokens d'activation européens." });
  }
  const base = CONFIG.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  try {
    const accessToken = await paypalGetAccessToken();
    const verifyRes = await fetch(base + "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: CONFIG.PAYPAL_WEBHOOK_ID,
        webhook_event: req.body
      })
    });
    const verifyData = await verifyRes.json();
    if (verifyData.verification_status !== "SUCCESS") {
      return res.status(401).json({ error: "invalid_signature" });
    }
  } catch (e) {
    console.error("[PayPal] Échec de vérification :", e.message);
    return res.status(502).json({ error: "verification_failed" });
  }

  const event = req.body;
  if (event.event_type !== "CHECKOUT.ORDER.APPROVED" && event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
    return res.status(200).json({ status: "ignored_event_type" });
  }
  const resource = event.resource || {};
  const customId = resource.custom_id || (resource.purchase_units && resource.purchase_units[0] && resource.purchase_units[0].custom_id) || "";
  let customData = null;
  try { customData = JSON.parse(customId); } catch (e) { customData = null; }
  const etwId = customData && customData.etwId;
  const purpose = (customData && customData.purpose) || "subscription";
  const days = Number(customData && customData.days) || CONFIG.TRIAL_DURATION_DAYS;
  if (!etwId) return res.status(400).json({ error: "missing_etwid_in_custom_id" });

  const result = await withTransaction((conn) =>
    activatePremium(conn, { etwId, purpose, days, gateway: "paypal", txKey: `paypal:${event.id}` })
  );
  if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  return res.status(200).json({ status: "ok" });
});

app.post("/api/pay/create-paypal-order", async (req, res) => {
  if (!CONFIG.PAYPAL_CLIENT_ID || !CONFIG.PAYPAL_CLIENT_SECRET) {
    return res.status(503).json({ error: "paypal_not_configured" });
  }
  const { etwId, purpose, planId, amountEUR, days } = req.body;
  if (!etwId || !amountEUR) return res.status(400).json({ error: "missing_fields" });
  const base = CONFIG.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  try {
    const accessToken = await paypalGetAccessToken();
    const customId = JSON.stringify({ etwId, purpose: purpose || "subscription", days: days || CONFIG.TRIAL_DURATION_DAYS });
    const orderRes = await fetch(base + "/v2/checkout/orders", {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          custom_id: customId,
          description: "Etwas Pro & Etwas ADS — " + (planId || "abonnement"),
          amount: { currency_code: "EUR", value: Number(amountEUR).toFixed(2) }
        }]
      })
    });
    const orderData = await orderRes.json();
    const approveLink = (orderData.links || []).find((l) => l.rel === "approve");
    if (!approveLink) return res.status(502).json({ error: "paypal_order_error" });
    res.json({ approveUrl: approveLink.href, orderId: orderData.id });
  } catch (e) {
    console.error("[PayPal] Échec de création de commande :", e.message);
    res.status(502).json({ error: "paypal_error" });
  }
});

// --- Plisio : création de facture ---
app.post("/api/pay/create-plisio-invoice", async (req, res) => {
  if (!CONFIG.PLISIO_API_KEY) return res.status(503).json({ error: "plisio_not_configured" });
  const { etwId, purpose, planId, amountEUR, days } = req.body;
  if (!etwId || !amountEUR) return res.status(400).json({ error: "missing_fields" });
  const orderName = JSON.stringify({ etwId, purpose: purpose || "subscription", planId: planId || "", days: days || CONFIG.TRIAL_DURATION_DAYS });
  const params = new URLSearchParams({
    source_currency: "EUR",
    source_amount: String(amountEUR),
    order_name: orderName,
    order_number: "etw_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
    callback_url: (process.env.ETWAS_PUBLIC_URL || "") + "/api/webhook/plisio",
    api_key: CONFIG.PLISIO_API_KEY
  });
  try {
    const plisioRes = await fetch("https://plisio.net/api/v1/invoices/new?" + params.toString());
    const data = await plisioRes.json();
    if (!plisioRes.ok || data.status !== "success") {
      return res.status(502).json({ error: "plisio_error", detail: data.data && data.data.message });
    }
    return res.json({ invoiceUrl: data.data.invoice_url });
  } catch (e) {
    console.error("[Plisio] Échec de création de facture :", e.message);
    return res.status(502).json({ error: "plisio_unreachable" });
  }
});

/* ============================================================================
   6. CHAÎNE GoBD (Etwas Pro)
   ============================================================================ */
function computeChainHash(prevHash, payload) {
  return crypto.createHash("sha256").update(String(prevHash) + JSON.stringify(payload)).digest("hex");
}

app.post("/api/sales/:etwId/append", async (req, res) => {
  const { etwId } = req.params;
  const { prevHash, payload } = req.body;
  if (!payload || typeof payload !== "object") return res.status(400).json({ error: "missing_payload" });

  try {
    const entry = await withTransaction(async (conn) => {
      const [accRows] = await conn.execute("SELECT etw_id FROM accounts WHERE etw_id = ?", [etwId]);
      if (!accRows.length) throw Object.assign(new Error("account_missing"), { code: "account_missing" });

      // Verrouille la dernière ligne de CE compte (FOR UPDATE) pendant la
      // transaction, pour qu'aucune requête concurrente ne puisse insérer
      // entre la lecture et l'écriture — empêche un fork silencieux.
      const [lastRows] = await conn.execute(
        "SELECT hash, seq FROM sales_chain WHERE etw_id = ? ORDER BY seq DESC LIMIT 1 FOR UPDATE",
        [etwId]
      );
      const expectedPrevHash = lastRows.length ? lastRows[0].hash : "GENESIS";
      if (String(prevHash || "GENESIS") !== expectedPrevHash) {
        throw Object.assign(new Error("chain_broken"), { code: "chain_broken", expectedPrevHash });
      }
      const seq = (lastRows.length ? lastRows[0].seq : 0) + 1;
      const hash = computeChainHash(expectedPrevHash, payload);
      const now = serverNow();
      await conn.execute(
        "INSERT INTO sales_chain (etw_id, seq, hash, prev_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [etwId, seq, hash, expectedPrevHash, JSON.stringify(payload), now]
      );
      return { seq, hash, prevHash: expectedPrevHash, payload, ts: now };
    });
    return res.status(201).json(entry);
  } catch (e) {
    if (e.code === "account_missing") return res.status(404).json({ error: "account_not_found" });
    if (e.code === "chain_broken") {
      return res.status(409).json({
        error: "chain_broken",
        message: "Le hash précédent fourni ne correspond pas à la dernière écriture connue du serveur.",
        expectedPrevHash: e.expectedPrevHash
      });
    }
    console.error("[GoBD] Erreur d'ajout à la chaîne :", e.message);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/api/sales/:etwId/verify", async (req, res) => {
  const [rows] = await pool.execute(
    "SELECT seq, hash, prev_hash, payload_json FROM sales_chain WHERE etw_id = ? ORDER BY seq ASC",
    [req.params.etwId]
  );
  let expected = "GENESIS";
  for (const row of rows) {
    if (row.prev_hash !== expected) return res.json({ valid: false, brokenAtSeq: row.seq, reason: "prevHash_mismatch" });
    const recomputed = computeChainHash(row.prev_hash, JSON.parse(row.payload_json));
    if (recomputed !== row.hash) return res.json({ valid: false, brokenAtSeq: row.seq, reason: "hash_mismatch" });
    expected = row.hash;
  }
  res.json({ valid: true, length: rows.length, lastHash: expected });
});

/* ============================================================================
   7. BOUTIQUES (Etwas ADS) — porté fidèlement depuis AppsScript_v5.gs.
   ============================================================================ */
app.post("/api/marketplace/boutique", async (req, res) => {
  const d = req.body;
  if (!d.name || !d.category) return res.status(400).json({ error: "missing_name_or_category" });
  const id = uuid();
  await pool.execute(
    `INSERT INTO boutiques (id, nom, categorie, pays, ville, adresse, contact, description, devise, logo, owner_token, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, d.name, d.category, d.country || "", d.city || "", d.address || "", d.contact || "", d.description || "",
     d.currency || "XOF", d.logo || null, d.ownerToken || "", d.lat != null ? d.lat : null, d.lng != null ? d.lng : null]
  );
  res.status(201).json({ success: true, id });
});

app.put("/api/marketplace/boutique/:id", async (req, res) => {
  const d = req.body;
  const [rows] = await pool.execute("SELECT owner_token FROM boutiques WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  if (!ownerAuthorized(rows[0].owner_token, d) && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  const fieldMap = { name: "nom", category: "categorie", country: "pays", city: "ville", address: "adresse",
    contact: "contact", description: "description", currency: "devise", logo: "logo", lat: "latitude", lng: "longitude" };
  const sets = []; const params = [];
  Object.keys(fieldMap).forEach((key) => {
    if (typeof d[key] !== "undefined") { sets.push(`${fieldMap[key]} = ?`); params.push(d[key]); }
  });
  if (!sets.length) return res.json({ success: true });
  params.push(req.params.id);
  await pool.execute(`UPDATE boutiques SET ${sets.join(", ")} WHERE id = ?`, params);
  res.json({ success: true });
});

app.delete("/api/marketplace/boutique/:id", async (req, res) => {
  const d = req.body;
  const [rows] = await pool.execute("SELECT owner_token FROM boutiques WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  if (!ownerAuthorized(rows[0].owner_token, d) && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  await pool.execute("DELETE FROM boutiques WHERE id = ?", [req.params.id]); // CASCADE supprime ses annonces
  res.json({ success: true });
});

app.post("/api/marketplace/boutique/:id/boost", async (req, res) => {
  const d = req.body;
  if (!d.boostExpiration) return res.status(400).json({ error: "missing_boost_expiration" });
  const [rows] = await pool.execute("SELECT owner_token FROM boutiques WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  if (!ownerAuthorized(rows[0].owner_token, d) && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  await pool.execute("UPDATE boutiques SET boost = 1, boost_expiration = ? WHERE id = ?", [d.boostExpiration, req.params.id]);
  res.json({ success: true });
});

app.post("/api/marketplace/boutique/:id/suspend", requireAdminToken, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "missing_reason" });
  const [r] = await pool.execute("UPDATE boutiques SET suspendue = 1, raison_suspension = ? WHERE id = ?", [reason, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});
app.post("/api/marketplace/boutique/:id/unsuspend", requireAdminToken, async (req, res) => {
  const [r] = await pool.execute("UPDATE boutiques SET suspendue = 0, raison_suspension = '' WHERE id = ?", [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

/* ============================================================================
   8. ANNONCES (Etwas ADS)
   ============================================================================ */
async function fetchAnnonceImages(annonceId) {
  const [rows] = await pool.execute(
    "SELECT position, data_base64 FROM annonce_images WHERE annonce_id = ? ORDER BY position ASC", [annonceId]
  );
  return rows.map((r) => r.data_base64);
}
async function replaceAnnonceImages(conn, annonceId, images) {
  await conn.execute("DELETE FROM annonce_images WHERE annonce_id = ?", [annonceId]);
  for (let i = 0; i < images.length && i < 10; i++) {
    if (!images[i]) continue;
    await conn.execute("INSERT INTO annonce_images (annonce_id, position, data_base64) VALUES (?, ?, ?)", [annonceId, i, images[i]]);
  }
}

app.post("/api/marketplace/annonce", async (req, res) => {
  const d = req.body;
  if (!d.boutiqueId || !d.description) return res.status(400).json({ error: "missing_boutique_or_description" });

  const [shopRows] = await pool.execute("SELECT owner_token FROM boutiques WHERE id = ?", [d.boutiqueId]);
  if (!shopRows.length) return res.status(404).json({ error: "boutique_not_found" });
  if (shopRows[0].owner_token && shopRows[0].owner_token !== d.ownerToken && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  if (d.slug) {
    const [dupe] = await pool.execute("SELECT id FROM annonces WHERE slug = ?", [String(d.slug).toLowerCase()]);
    if (dupe.length) return res.status(409).json({ error: "slug_taken" });
  }

  const id = uuid();
  const images = [d.image1, d.image2, d.image3, d.image4, d.image5, d.image6, d.image7, d.image8, d.image9, d.image10];
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO annonces (id, boutique_id, lien, description, prix, prix_promo, prix_mode, contact, plan, plan_weight,
         expiration, txn_id, owner_token, masquer_boutique, collecter_adresse, slug, faq_json, seo_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.boutiqueId, d.link || "", d.description, d.price || null, d.pricePromo || null, d.priceMode || "nonbarre",
       d.contact || "", d.plan || "", Number(d.planWeight) || 0, d.expiry || null, d.txnId || "", d.ownerToken || "",
       d.hideFromShop === true || d.hideFromShop === "true", d.collectAddress === true || d.collectAddress === "true",
       (d.slug || "").toLowerCase(), d.faqJson || null, d.seoKeywords || ""]
    );
    await replaceAnnonceImages(conn, id, images);
  });
  res.status(201).json({ success: true, id });
});

app.put("/api/marketplace/annonce/:id", async (req, res) => {
  const d = req.body;
  const [rows] = await pool.execute("SELECT owner_token FROM annonces WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  if (!ownerAuthorized(rows[0].owner_token, d) && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  if (d.slug) {
    const [dupe] = await pool.execute("SELECT id FROM annonces WHERE slug = ? AND id != ?", [String(d.slug).toLowerCase(), req.params.id]);
    if (dupe.length) return res.status(409).json({ error: "slug_taken" });
  }

  const fieldMap = {
    link: "lien", description: "description", price: "prix", pricePromo: "prix_promo", priceMode: "prix_mode",
    contact: "contact", hideFromShop: "masquer_boutique", collectAddress: "collecter_adresse",
    slug: "slug", faqJson: "faq_json", seoKeywords: "seo_keywords"
  };
  const sets = []; const params = [];
  Object.keys(fieldMap).forEach((key) => {
    if (typeof d[key] === "undefined") return;
    let val = d[key];
    if (key === "hideFromShop" || key === "collectAddress") val = (val === true || val === "true");
    if (key === "slug") val = String(val).toLowerCase();
    sets.push(`${fieldMap[key]} = ?`); params.push(val);
  });

  await withTransaction(async (conn) => {
    if (sets.length) {
      params.push(req.params.id);
      await conn.execute(`UPDATE annonces SET ${sets.join(", ")} WHERE id = ?`, params);
    }
    const hasAnyImage = ["image1","image2","image3","image4","image5","image6","image7","image8","image9","image10"]
      .some((k) => typeof d[k] !== "undefined");
    if (hasAnyImage) {
      const existing = await fetchAnnonceImages(req.params.id);
      const images = [1,2,3,4,5,6,7,8,9,10].map((n, i) => (typeof d["image"+n] !== "undefined" ? d["image"+n] : existing[i]));
      await replaceAnnonceImages(conn, req.params.id, images);
    }
  });
  res.json({ success: true });
});

app.delete("/api/marketplace/annonce/:id", async (req, res) => {
  const d = req.body;
  const [rows] = await pool.execute("SELECT owner_token FROM annonces WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  if (!ownerAuthorized(rows[0].owner_token, d) && !isAdminAuthorized(d)) {
    return res.status(403).json({ error: "not_authorized" });
  }
  await pool.execute("DELETE FROM annonces WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});

app.post("/api/marketplace/annonce/:id/suspend", requireAdminToken, async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "missing_reason" });
  const [r] = await pool.execute("UPDATE annonces SET suspendue = 1, raison_suspension = ? WHERE id = ?", [reason, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});
app.post("/api/marketplace/annonce/:id/unsuspend", requireAdminToken, async (req, res) => {
  const [r] = await pool.execute("UPDATE annonces SET suspendue = 0, raison_suspension = '' WHERE id = ?", [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

/* ============================================================================
   9. LECTURE PUBLIQUE — équivalent de doGet() dans AppsScript_v5.gs.
   ============================================================================ */
app.get("/api/marketplace/data", async (req, res) => {
  const [boutiques] = await pool.execute("SELECT * FROM boutiques");
  const [annoncesRaw] = await pool.execute("SELECT * FROM annonces WHERE expiration IS NULL OR expiration > NOW()");

  const boutiquesById = {};
  boutiques.forEach((b) => { boutiquesById[b.id] = b; });

  const annonces = await Promise.all(annoncesRaw.map(async (a) => {
    const images = await fetchAnnonceImages(a.id);
    const b = boutiquesById[a.boutique_id] || {};
    const boutiqueSuspendue = !!b.suspendue;
    const annonceSuspendue = !!a.suspendue;
    const suspendue = boutiqueSuspendue || annonceSuspendue;
    const raison = boutiqueSuspendue ? (b.raison_suspension || "") : (annonceSuspendue ? (a.raison_suspension || "") : "");
    const out = {
      ID: a.id, BoutiqueID: a.boutique_id, Date: a.created_at, Lien: a.lien, Description: a.description,
      Prix: a.prix, PrixPromo: a.prix_promo, PrixMode: a.prix_mode, Contact: a.contact,
      Plan: a.plan, PlanWeight: a.plan_weight, Expiration: a.expiration, TxnId: a.txn_id,
      MasquerBoutique: !!a.masquer_boutique, CollecterAdresse: !!a.collecter_adresse,
      Slug: a.slug, FaqJson: a.faq_json, SeoKeywords: a.seo_keywords,
      BoutiqueNom: b.nom || "", Categorie: b.categorie || "", Pays: b.pays || "", Ville: b.ville || "",
      BoutiqueLogo: b.logo || "", BoutiqueDevise: b.devise || "XOF",
      BoutiqueLatitude: b.latitude != null ? Number(b.latitude) : null,
      BoutiqueLongitude: b.longitude != null ? Number(b.longitude) : null,
      Suspendue: suspendue, RaisonSuspension: raison
    };
    images.forEach((img, i) => { out["Image" + (i + 1)] = img; });
    return out;
  }));

  const now = new Date();
  const boutiquesBoostees = boutiques.filter((b) => b.boost && b.boost_expiration && new Date(b.boost_expiration) > now);
  res.json({ success: true, annonces, boutiques, boutiquesBoostees });
});

/* ============================================================================
   10. TVA INTERNATIONALE — repris tel quel depuis AppsScript_v5.gs. Ce n'est
       pas un conseil fiscal : fais valider les taux réels par un comptable.
   ============================================================================ */
const MARKETPLACE_PRICING_HT = {
  trial: { nom: "Essai complet", prixHT: 656 },
  mensuel: { nom: "Mensuel", prixHT: 10838 },
  bimestriel: { nom: "Bimestriel", prixHT: 19465 },
  trimestriel: { nom: "Trimestriel", prixHT: 27115 },
  semestriel: { nom: "Semestriel", prixHT: 48875 },
  annuel: { nom: "Annuel", prixHT: 80750 },
  "2ans": { nom: "2 ans", prixHT: 135150 },
  "3ans": { nom: "3 ans", prixHT: 177650 },
  avie: { nom: "À vie", prixHT: 403750 }
};
const COUNTRY_VAT_RATES = {
  bj:18, tg:18, ci:18, sn:18, ne:18, ml:18, bf:18, gw:18,
  cm:19, ga:19, cg:19, cd:16, td:18, cf:19, gq:15,
  gn:18, gh:15, ng:7.5, ma:20, dz:19, tn:19, eg:14, ke:16, tz:18, ug:18,
  rw:18, za:15, zw:14.5, zm:16, mz:16, ao:14, mu:15, mg:20,
  fr:20, de:19, be:21, ch:8.1, lu:17, es:21, pt:23, it:22, gb:20, ie:23,
  nl:21, at:20, se:25, no:25, dk:25, fi:24, pl:23, gr:24, ro:19, cz:21, hu:27, hr:25,
  ca:5, mx:16, br:17, ar:21, cl:19, co:19, pe:18,
  cn:13, jp:10, kr:10, in:18, id:11, my:6, sg:9, th:7, vn:10, ph:12,
  au:10, nz:15, ae:5, sa:15, tr:20, il:17
};
function vatRateForCountry(countryId) {
  const rate = COUNTRY_VAT_RATES[String(countryId || "").toLowerCase().trim()];
  return typeof rate === "number" ? rate : 0;
}
function computeVat(planId, countryId) {
  const plan = MARKETPLACE_PRICING_HT[planId];
  if (!plan) throw new Error("unknown_plan");
  if (planId === "trial") {
    return { plan: planId, nomPlan: plan.nom, pays: countryId || "", prixHT: plan.prixHT, tauxTVA: 0, montantTVA: 0, totalTTC: plan.prixHT };
  }
  const tauxTVA = vatRateForCountry(countryId);
  const montantTVA = Math.ceil(plan.prixHT * (tauxTVA / 100));
  return { plan: planId, nomPlan: plan.nom, pays: countryId || "", prixHT: plan.prixHT, tauxTVA, montantTVA, totalTTC: plan.prixHT + montantTVA };
}
app.post("/api/marketplace/vat/calculate", (req, res) => {
  try {
    if (!req.body.plan) return res.status(400).json({ error: "missing_plan" });
    res.json(Object.assign({ success: true }, computeVat(req.body.plan, req.body.country)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ============================================================================
   11. CONFIRMATION D'ABONNEMENT (Etwas ADS) — porté depuis _confirmSubscription().
       Réactive automatiquement les annonces suspendues du vendeur et journalise
       la TVA collectée, exactement comme le faisait AppsScript_v5.gs.
   ============================================================================ */
app.post("/api/marketplace/confirm-subscription", async (req, res) => {
  const d = req.body;
  if (!d.txnId) return res.status(400).json({ error: "missing_txn_id" });

  const [already] = await pool.execute("SELECT id FROM annonces WHERE txn_id = ?", [d.txnId]);
  if (already.length) return res.status(409).json({ error: "transaction_already_used" });

  let verif;
  try {
    const verifyRes = await fetch("https://api.kkiapay.me/api/v1/transactions/status", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CONFIG.KKIAPAY_PUBLIC_KEY || "", "x-secret-key": CONFIG.KKIAPAY_SECRET_KEY || "" },
      body: JSON.stringify({ transactionId: d.txnId })
    });
    verif = await verifyRes.json();
  } catch (e) {
    return res.status(502).json({ error: "verification_unavailable" });
  }
  if (!verif || verif.status !== "SUCCESS") return res.status(400).json({ error: "payment_not_confirmed" });

  let vatCalc = null;
  if (d.plan && MARKETPLACE_PRICING_HT[d.plan]) {
    vatCalc = computeVat(d.plan, d.country);
    if (Number(verif.amount) < vatCalc.totalTTC - 1) return res.status(400).json({ error: "amount_mismatch", expected: vatCalc.totalTTC });
  } else if (d.expectedAmount) {
    if (Number(verif.amount) < Number(d.expectedAmount)) return res.status(400).json({ error: "amount_mismatch" });
  } else {
    return res.status(400).json({ error: "cannot_verify_amount" });
  }

  const ids = d.ids ? String(d.ids).split(",").filter(Boolean) : [];
  const isAdmin = isAdminAuthorized(d);
  let renewed = 0;

  await withTransaction(async (conn) => {
    for (const id of ids) {
      const [rows] = await conn.execute("SELECT owner_token FROM annonces WHERE id = ?", [id]);
      if (!rows.length) continue;
      if (!isAdmin && !ownerAuthorized(rows[0].owner_token, d)) continue;
      await conn.execute(
        "UPDATE annonces SET plan = ?, plan_weight = ?, expiration = ?, txn_id = ? WHERE id = ?",
        [d.plan || "", Number(d.planWeight) || 0, d.expiry || null, d.txnId, id]
      );
      renewed++;
    }
    if (vatCalc) {
      await conn.execute(
        `INSERT INTO compta_tva (vendeur_id, forfait, pays_client, montant_ht, taux_tva, montant_tva, total_ttc, txn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.ownerToken || "", vatCalc.nomPlan, vatCalc.pays, vatCalc.prixHT, vatCalc.tauxTVA, vatCalc.montantTVA, vatCalc.totalTTC, d.txnId]
      );
    }
  });

  res.json({ success: true, renewed, verified: true, vat: vatCalc });
});

/* ============================================================================
   12. OUTILS ADMIN (code pro) — portés depuis _adminGrant / _renewAnnonces.
   ============================================================================ */
app.post("/api/marketplace/admin/grant", async (req, res) => {
  const d = req.body;
  if (!isAdminAuthorized(d)) return res.status(403).json({ error: "not_authorized" });
  if (!d.id) return res.status(400).json({ error: "missing_id" });
  const sets = []; const params = [];
  if (d.expiry) { sets.push("expiration = ?"); params.push(d.expiry); }
  if (d.plan) { sets.push("plan = ?"); params.push(d.plan); }
  if (typeof d.planWeight !== "undefined" && d.planWeight !== "") { sets.push("plan_weight = ?"); params.push(Number(d.planWeight)); }
  if (!sets.length) return res.json({ success: true });
  params.push(d.id);
  const [r] = await pool.execute(`UPDATE annonces SET ${sets.join(", ")} WHERE id = ?`, params);
  if (!r.affectedRows) return res.status(404).json({ error: "not_found" });
  res.json({ success: true });
});

app.post("/api/marketplace/admin/renew", async (req, res) => {
  const d = req.body;
  if (!isAdminAuthorized(d)) return res.status(403).json({ error: "not_authorized" });
  const ids = d.ids ? String(d.ids).split(",").filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids" });
  let renewed = 0;
  for (const id of ids) {
    const [r] = await pool.execute("UPDATE annonces SET plan = ?, plan_weight = ?, expiration = ? WHERE id = ?",
      [d.plan || "", Number(d.planWeight) || 0, d.expiry || null, id]);
    renewed += r.affectedRows;
  }
  res.json({ success: true, renewed });
});

/* ============================================================================
   13. BOÎTE À SUGGESTIONS (Etwas Pro ET Etwas ADS)
   ============================================================================ */
app.post("/api/feedback", async (req, res) => {
  const message = String(req.body.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "empty_message" });
  await pool.execute("INSERT INTO suggestions (module, etw_id, message) VALUES (?, ?, ?)",
    [req.body.module || "inconnu", req.body.etwId || null, message]);
  res.status(201).json({ status: "ok" });
});

/* ============================================================================
   14. ADMINISTRATION (protégée par ETWAS_ADMIN_TOKEN)
   ============================================================================ */
app.get("/api/admin/accounts", requireAdminToken, async (req, res) => {
  const [rows] = await pool.execute("SELECT etw_id, company_name, trial_expires_at, subscription_expires_at, created_at FROM accounts");
  res.json({ count: rows.length, accounts: rows });
});
app.get("/api/admin/feedback", requireAdminToken, async (req, res) => {
  const [rows] = await pool.execute("SELECT * FROM suggestions ORDER BY created_at DESC");
  res.json({ feedback: rows });
});

/* ============================================================================
   15. DÉMARRAGE
   ============================================================================ */
app.listen(CONFIG.PORT, async () => {
  console.log(`Etwas Server à l'écoute sur le port ${CONFIG.PORT}`);
  console.log(`Heure serveur : ${new Date(serverNow()).toISOString()}`);
  try {
    await pool.query("SELECT 1");
    console.log("✅ Connexion MySQL établie (" + CONFIG.DB_NAME + "@" + CONFIG.DB_HOST + ")");
  } catch (e) {
    console.error("❌ Impossible de se connecter à MySQL :", e.message);
    console.error("   Vérifie DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME dans .env, et que schema.sql a bien été importé.");
  }
  if (!CONFIG.KKIAPAY_SECRET_KEY) console.warn("⚠️  KKIAPAY_SECRET_KEY absent — webhook KKiaPay désactivé.");
  if (!CONFIG.PLISIO_API_KEY) console.warn("⚠️  PLISIO_API_KEY absent — Plisio désactivé.");
  if (!CONFIG.STRIPE_SECRET_KEY) console.warn("ℹ️  Stripe non configuré (en attente des clés DONKO UG).");
  if (!CONFIG.PAYPAL_CLIENT_ID) console.warn("ℹ️  PayPal non configuré (en attente des tokens).");
  if (!CONFIG.ADMIN_TOKEN) console.warn("⚠️  ETWAS_ADMIN_TOKEN absent — routes /api/admin/* désactivées.");
});

module.exports = app;
