/* ============================================================================
   ETWAS SERVER — Backend Node.js / Express
   ============================================================================
   Rôle de ce fichier : porter tout ce qui NE PEUT PAS rester côté client sans
   ouvrir la porte à la triche (déblocage Pro en modifiant le LocalStorage,
   rejeu d'une transaction de paiement, falsification de l'horloge locale,
   modification a posteriori d'une facture déjà émise...).

   Ce que ce fichier fait :
     - Émet l'heure officielle du serveur (anti-triche horloge locale).
     - Crée et interroge les comptes Etwas (ID unique ETW-XXXX-XXXX-XXXX).
     - Reçoit les webhooks KKiaPay et Plisio, vérifie leur authenticité et les
       protège contre le rejeu (une transaction ne peut être appliquée qu'UNE
       seule fois), puis active/prolonge le Trial (1€/30j) ou l'abonnement.
     - Prépare les webhooks Stripe et PayPal (structure prête, désactivée tant
       que les clés API réelles de DONKO UG / de la société actuelle ne sont
       pas fournies en variables d'environnement).
     - Tient un registre GoBD : chaque vente/facture d'Etwas Pro est chaînée
       par hachage SHA-256 à la précédente ; toute rupture de chaîne est
       détectée et rejetée (immuabilité comptable).
     - Gère le statut "boosted" des annonces Etwas ADS après paiement confirmé.

   Ce que ce fichier NE fait PAS (volontairement, à ce stade) :
     - Il n'est pas déployé : c'est un point de départ à héberger toi-même
       sur ton VPS (Hostinger ou autre), avec Node.js ≥ 18 installé.
     - Il n'est PAS connecté à de vraies clés API. Tant que les variables
       d'environnement ne sont pas renseignées, les routes correspondantes
       répondent explicitement "non configuré" plutôt que d'échouer en
       silence ou d'accepter une requête non vérifiable.
     - Le stockage utilise un fichier JSON local (etwas-data.json) — simple,
       lisible, suffisant pour démarrer et pour un volume modeste. Pour une
       montée en charge sérieuse, remplace la couche `db.*` tout en bas de
       ce fichier par une vraie base (PostgreSQL, MySQL, SQLite...) : toutes
       les routes au-dessus n'ont pas besoin de changer, elles passent déjà
       par cette couche d'abstraction.

   Démarrage :
     1. npm install
     2. copie .env.example vers .env et renseigne tes vraies clés
     3. node EtwasServer.js
   ============================================================================ */

"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// dotenv est optionnel : si absent, on continue avec process.env tel quel
// (utile en production où les variables sont injectées par l'hébergeur).
try { require("dotenv").config(); } catch (e) { /* pas grave si absent */ }

const app = express();
app.use(express.json({
  limit: "2mb",
  // On garde le corps brut pour les webhooks qui exigent une vérification
  // de signature calculée sur les octets exacts reçus (Stripe notamment).
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

/* ============================================================================
   0. CONFIGURATION — tout vient des variables d'environnement.
      AUCUNE clé, secret ou identifiant réel n'est écrit en dur ici : c'est
      une règle de sécurité non négociable (un secret commité dans le code
      finit tôt ou tard exposé publiquement, même dans un repo privé).
   ============================================================================ */
const CONFIG = {
  PORT: process.env.PORT || 3000,

  // Jeton d'administration pour les routes sensibles (dashboard interne,
  // recalcul de chaîne GoBD, etc.) — génère une longue valeur aléatoire
  // et garde-la secrète : `openssl rand -hex 32`
  ADMIN_TOKEN: process.env.ETWAS_ADMIN_TOKEN || null,

  // --- KKiaPay (Mobile Money & carte, Afrique) — actif en production ---
  KKIAPAY_PUBLIC_KEY: process.env.KKIAPAY_PUBLIC_KEY || null,
  KKIAPAY_SECRET_KEY: process.env.KKIAPAY_SECRET_KEY || null,

  // --- Plisio (crypto : USDT, BTC...) — actif en production ---
  PLISIO_API_KEY: process.env.PLISIO_API_KEY || null,

  // --- Stripe — pré-intégré, en attente des clés DONKO UG (Europe) ---
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || null,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || null,

  // --- PayPal — pré-intégré, en attente des tokens d'activation ---
  PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID || null,
  PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || null,

  // Devise pivot : toute la comptabilité interne et le stockage serveur
  // se font en EUR. Les modules clients n'envoient QUE des montants EUR
  // au serveur ; l'affichage multi-devise reste une conversion locale
  // côté client (EtwasCurrency.js), jamais une valeur stockée ici.
  PIVOT_CURRENCY: "EUR",

  // Essai payant obligatoire : 1 € pour 30 jours d'accès Premium total.
  TRIAL_PRICE_EUR: 1,
  TRIAL_DURATION_DAYS: 30,

  // Fenêtre de tolérance pour l'horloge du client avant de bloquer les
  // actions sensibles (voir /api/time et la logique anti-triche associée).
  CLOCK_DRIFT_TOLERANCE_MS: 5 * 60 * 1000 // 5 minutes
};

/* ============================================================================
   1. PERSISTANCE — fichier JSON local, écriture atomique.
      Structure minimale volontairement simple et lisible :
        accounts:  { [etwId]: { companyName, trialExpiresAt, subExpiresAt, createdAt } }
        processedTx: { [gateway:transactionId]: true }   → verrou anti-rejeu
        salesChain: { [etwId]: [ {seq, hash, prevHash, payload, ts} ... ] }
        boostedAds: { [adId]: { expiresAt, ownerEtwId } }
   ============================================================================ */
const DB_FILE = path.join(__dirname, "etwas-data.json");

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    // Premier démarrage, ou fichier corrompu : on repart d'une base saine
    // plutôt que de planter le serveur.
    return { accounts: {}, processedTx: {}, salesChain: {}, boostedAds: {} };
  }
}

function saveDB(db) {
  // Écriture atomique : on écrit dans un fichier temporaire puis on
  // renomme, pour ne jamais laisser etwas-data.json dans un état à
  // moitié écrit si le process est interrompu en plein milieu.
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

// Toutes les routes passent par ce petit wrapper : lecture, mutation,
// écriture — jamais d'accès concurrent incohérent puisque Node.js est
// mono-thread pour l'exécution JS (chaque requête traite sa mutation
// avant de rendre la main à la boucle d'événements).
function withDB(mutatorFn) {
  const db = loadDB();
  const result = mutatorFn(db);
  saveDB(db);
  return result;
}

/* ============================================================================
   2. UTILITAIRES
   ============================================================================ */

// Génère un ID unique Etwas au format ETW-XXXX-XXXX-XXXX (voir cahier des
// charges "Identité & Sync"). Utilise crypto.randomBytes pour un vrai
// aléa cryptographique, pas Math.random().
function generateEtwId() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `ETW-${seg()}-${seg()}-${seg()}`;
}

// Comparaison en temps constant pour éviter les attaques par mesure de
// timing sur la vérification de signatures/secrets.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Timestamp serveur officiel — c'est la SEULE source de vérité temporelle
// pour tout calcul d'expiration (Trial / abonnement / boost). Le client
// ne doit jamais faire confiance à `Date.now()` local pour ces calculs.
function serverNow() {
  return Date.now();
}

function requireAdmin(req, res, next) {
  if (!CONFIG.ADMIN_TOKEN) {
    return res.status(503).json({ error: "admin_not_configured", message: "ETWAS_ADMIN_TOKEN non défini côté serveur." });
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, CONFIG.ADMIN_TOKEN)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/* ============================================================================
   3. MIDDLEWARE GLOBAL — horodatage serveur sur CHAQUE réponse.
      Conformément au cahier des charges anti-triche : chaque réponse porte
      le Timestamp Unix officiel du serveur en en-tête. Le client
      (EtwasShell.js) compare cette valeur à son horloge locale ; en cas
      d'écart supérieur à la tolérance, il bloque les actions sensibles et
      recalcule toute expiration Trial/Abonnement sur la base de CETTE
      valeur serveur, jamais sur l'horloge locale.
   ============================================================================ */
app.use((req, res, next) => {
  res.setHeader("X-Etwas-Server-Time", String(serverNow()));
  next();
});

// CORS minimal — à restreindre au(x) domaine(s) réel(s) d'Etwas en
// production (remplace "*" par ton domaine exact une fois en ligne).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ETWAS_ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ============================================================================
   4. HORLOGE SERVEUR — endpoint dédié, appelé par EtwasShell.js au
      démarrage et périodiquement pour détecter une horloge locale
      trafiquée (contournement frauduleux d'une expiration Trial).
   ============================================================================ */
app.get("/api/time", (req, res) => {
  res.json({
    serverTime: serverNow(),
    toleranceMs: CONFIG.CLOCK_DRIFT_TOLERANCE_MS
  });
});

/* ============================================================================
   5. COMPTES ETWAS — création, statut, reconnexion.
   ============================================================================ */

// Création d'un nouveau compte : génère l'ID unique, enregistre le nom
// d'entreprise. Le Trial n'est PAS activé ici — il ne s'active qu'à la
// confirmation du paiement de 1€ via webhook (voir section 6), pour
// qu'aucun accès Premium ne dépende d'une simple requête client.
app.post("/api/account/create", (req, res) => {
  const companyName = String(req.body.companyName || "").trim();
  if (!companyName) {
    return res.status(400).json({ error: "missing_company_name" });
  }
  const etwId = withDB((db) => {
    const id = generateEtwId();
    db.accounts[id] = {
      companyName,
      createdAt: serverNow(),
      trialExpiresAt: null,     // activé uniquement par webhook de paiement
      subscriptionExpiresAt: null
    };
    return id;
  });
  res.json({ etwId, companyName, createdAt: serverNow() });
});

// Statut Pro/Premium d'un compte — calculé UNIQUEMENT à partir de
// l'horloge serveur. C'est cette route que le client interroge avant
// toute action sensible (voir cahier des charges "interdisant tout
// contournement par modification frauduleuse du LocalStorage").
app.get("/api/account/:etwId/status", (req, res) => {
  const db = loadDB();
  const account = db.accounts[req.params.etwId];
  if (!account) return res.status(404).json({ error: "account_not_found" });

  const now = serverNow();
  const trialActive = !!(account.trialExpiresAt && account.trialExpiresAt > now);
  const subActive = !!(account.subscriptionExpiresAt && account.subscriptionExpiresAt > now);

  res.json({
    etwId: req.params.etwId,
    companyName: account.companyName,
    isPremium: trialActive || subActive,
    trial: {
      active: trialActive,
      expiresAt: account.trialExpiresAt
    },
    subscription: {
      active: subActive,
      expiresAt: account.subscriptionExpiresAt
    },
    // Bandeau d'alerte J-5 : le client peut comparer expiresAt à serverTime
    // et déclencher lui-même l'affichage — pas de logique cachée ici,
    // juste la donnée brute et fiable.
    serverTime: now
  });
});

/* ============================================================================
   6. WEBHOOKS DE PAIEMENT — cœur de la sécurité anti-triche.

      Principe commun à TOUS les webhooks ci-dessous :
        1. Vérifier l'authenticité de la requête (signature / secret propre
           à chaque passerelle — jamais une confiance aveugle dans le corps
           JSON reçu).
        2. Vérifier que l'ID de transaction n'a JAMAIS été traité avant
           (protection anti-rejeu : `db.processedTx`).
        3. Appliquer l'effet métier (activer Trial, prolonger abonnement,
           booster une annonce) UNIQUEMENT après les deux vérifications
           précédentes.
        4. Marquer la transaction comme traitée avant de répondre 200 —
           pour qu'un retry de la passerelle en cas de timeout réseau ne
           double-crédite jamais le compte.
   ============================================================================ */

// --- 6.1 KKiaPay (Mobile Money & carte) — actif en production ---
app.post("/api/webhook/kkiapay", async (req, res) => {
  if (!CONFIG.KKIAPAY_SECRET_KEY) {
    return res.status(503).json({ error: "kkiapay_not_configured" });
  }

  // KKiaPay transmet l'ID de transaction ; on vérifie son authenticité
  // via leur API de confirmation server-to-server (recommandé par KKiaPay
  // plutôt que de faire confiance au webhook seul, qui peut être simulé
  // par un tiers qui devinerait l'URL). Voir doc KKiaPay "Vérification
  // d'une transaction" — remplace CONFIG.KKIAPAY_SECRET_KEY par ta clé
  // secrète réelle et adapte l'URL si KKiaPay la fait évoluer.
  // KKiaPay renvoie tel quel, dans son callback, le champ "data" que le
  // client lui a transmis à l'ouverture du widget. Etwas y encode un JSON
  // {etwId, purpose, planId} — mais KKiaPay peut le livrer soit comme
  // chaîne brute, soit déjà parsé selon l'intégration : on gère les deux.
  let clientData = req.body.data;
  if (typeof clientData === "string") {
    try { clientData = JSON.parse(clientData); } catch (e) { clientData = null; }
  }
  const transactionId = req.body.transactionId || req.body.transactionid || (clientData && clientData.ref);
  const etwId = req.body.etwId || (clientData && clientData.etwId);
  const purpose = req.body.purpose || (clientData && clientData.purpose) || "trial";
  const adId = req.body.adId || (clientData && clientData.adId);

  if (!transactionId || !etwId) {
    return res.status(400).json({ error: "missing_transaction_or_account" });
  }

  const txKey = `kkiapay:${transactionId}`;

  try {
    // Vérification server-to-server auprès de KKiaPay (à adapter à leur
    // endpoint réel une fois les clés en place — structure indicative).
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
    console.error("[KKiaPay] Échec de vérification server-to-server :", e.message);
    return res.status(502).json({ error: "verification_failed" });
  }

  const result = withDB((db) => {
    if (db.processedTx[txKey]) {
      return { alreadyProcessed: true };
    }
    if (!db.accounts[etwId]) {
      return { accountMissing: true };
    }
    const now = serverNow();
    const account = db.accounts[etwId];

    if (purpose === "trial") {
      account.trialExpiresAt = now + CONFIG.TRIAL_DURATION_DAYS * 86400000;
    } else if (purpose === "subscription") {
      // Prolonge à partir de la date d'expiration existante si elle est
      // encore dans le futur (renouvellement anticipé), sinon à partir
      // de maintenant.
      const base = (account.subscriptionExpiresAt && account.subscriptionExpiresAt > now)
        ? account.subscriptionExpiresAt : now;
      account.subscriptionExpiresAt = base + CONFIG.TRIAL_DURATION_DAYS * 86400000;
    } else if (purpose === "boost" && adId) {
      db.boostedAds[adId] = {
        ownerEtwId: etwId,
        expiresAt: now + 31 * 86400000 // boost valable 31 jours
      };
    }

    db.processedTx[txKey] = { gateway: "kkiapay", etwId, purpose, at: now };
    return { ok: true };
  });

  if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  return res.status(200).json({ status: "ok" });
});

// --- 6.2 Plisio (crypto : USDT, BTC...) — actif en production ---
app.post("/api/webhook/plisio", (req, res) => {
  if (!CONFIG.PLISIO_API_KEY) {
    return res.status(503).json({ error: "plisio_not_configured" });
  }

  // Plisio signe ses callbacks avec un hash calculé sur les champs du
  // callback + ta clé API secrète (voir doc Plisio "Verify Hash"). On
  // reconstruit ce hash côté serveur et on le compare en temps constant
  // à celui reçu — c'est ce qui empêche un tiers d'imiter un paiement.
  const body = { ...req.body };
  const receivedHash = body.verify_hash;
  delete body.verify_hash;

  const ordered = {};
  Object.keys(body).sort().forEach((k) => { ordered[k] = body[k]; });
  const computedHash = crypto
    .createHmac("sha1", CONFIG.PLISIO_API_KEY)
    .update(JSON.stringify(ordered))
    .digest("hex");

  if (!receivedHash || !safeEqual(computedHash, receivedHash)) {
    return res.status(401).json({ error: "invalid_signature" });
  }

  if (body.status !== "completed" && body.status !== "mismatch paid") {
    // Statuts intermédiaires (pending, new...) : on accuse réception sans
    // créditer le compte, Plisio renverra un nouveau callback au statut final.
    return res.status(200).json({ status: "acknowledged_pending" });
  }

  const transactionId = body.txn_id || body.order_number;
  // Convention Etwas : au moment de créer la facture Plisio (côté client),
  // on place dans "order_name" un JSON {etwId, purpose, adId} — Plisio nous
  // le renvoie tel quel dans son callback. On protège le parsing au cas où
  // ce champ contiendrait autre chose qu'un JSON valide.
  let orderData = null;
  try { orderData = JSON.parse(body.order_name || "null"); } catch (e) { orderData = null; }
  const etwId = (orderData && orderData.etwId) || body.order_name;
  const purpose = (orderData && orderData.purpose) || body.purpose || "trial";
  const adId = (orderData && orderData.adId) || body.adId;

  if (!transactionId || !etwId) {
    return res.status(400).json({ error: "missing_transaction_or_account" });
  }

  const txKey = `plisio:${transactionId}`;
  const result = withDB((db) => {
    if (db.processedTx[txKey]) return { alreadyProcessed: true };
    if (!db.accounts[etwId]) return { accountMissing: true };

    const now = serverNow();
    const account = db.accounts[etwId];
    if (purpose === "trial") {
      account.trialExpiresAt = now + CONFIG.TRIAL_DURATION_DAYS * 86400000;
    } else if (purpose === "subscription") {
      const base = (account.subscriptionExpiresAt && account.subscriptionExpiresAt > now)
        ? account.subscriptionExpiresAt : now;
      account.subscriptionExpiresAt = base + CONFIG.TRIAL_DURATION_DAYS * 86400000;
    } else if (purpose === "boost" && adId) {
      db.boostedAds[adId] = { ownerEtwId: etwId, expiresAt: now + 31 * 86400000 };
    }
    db.processedTx[txKey] = { gateway: "plisio", etwId, purpose, at: now };
    return { ok: true };
  });

  if (result.alreadyProcessed) return res.status(200).json({ status: "already_processed" });
  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  return res.status(200).json({ status: "ok" });
});

// --- 6.3 Stripe — pré-intégré, en attente des clés DONKO UG ---
app.post("/api/webhook/stripe", (req, res) => {
  if (!CONFIG.STRIPE_SECRET_KEY || !CONFIG.STRIPE_WEBHOOK_SECRET) {
    // Réponse explicite plutôt qu'une route qui échoue silencieusement :
    // tant que DONKO UG n'a pas de clés Stripe, ce tunnel reste désactivé
    // proprement côté client (voir EtwasShell.js → bouton Stripe grisé).
    return res.status(503).json({ error: "stripe_not_configured", message: "En attente des clés API DONKO UG." });
  }
  // Une fois les clés fournies :
  //   const stripe = require("stripe")(CONFIG.STRIPE_SECRET_KEY);
  //   const sig = req.headers["stripe-signature"];
  //   const event = stripe.webhooks.constructEvent(req.rawBody, sig, CONFIG.STRIPE_WEBHOOK_SECRET);
  //   → puis même logique anti-rejeu que KKiaPay/Plisio ci-dessus,
  //     avec event.id comme clé processedTx.
  return res.status(501).json({ error: "not_implemented_yet" });
});

// --- 6.4 PayPal — pré-intégré, en attente des tokens d'activation ---
app.post("/api/webhook/paypal", (req, res) => {
  if (!CONFIG.PAYPAL_CLIENT_ID || !CONFIG.PAYPAL_CLIENT_SECRET) {
    return res.status(503).json({ error: "paypal_not_configured", message: "En attente des tokens d'activation européens." });
  }
  // Une fois les tokens fournis : vérifier la signature via l'API
  // PayPal "Verify Webhook Signature", puis même logique anti-rejeu
  // (resource.id comme clé processedTx) que les autres passerelles.
  return res.status(501).json({ error: "not_implemented_yet" });
});

/* ============================================================================
   7. CHAÎNE GoBD — immuabilité comptable pour Etwas Pro.

      Principe : chaque écriture de vente/facture doit inclure le hachage
      SHA-256 de la ligne précédente de CE compte. Le serveur recalcule le
      hachage attendu et REJETTE toute insertion si la chaîne fournie par
      le client ne correspond pas à sa dernière ligne connue — ce qui rend
      impossible d'insérer discrètement une facture après coup, ou d'en
      modifier une déjà émise sans casser la chaîne visiblement.
   ============================================================================ */

function computeChainHash(prevHash, payload) {
  return crypto
    .createHash("sha256")
    .update(String(prevHash) + JSON.stringify(payload))
    .digest("hex");
}

// Ajoute une écriture à la chaîne comptable d'un compte.
// Corps attendu : { prevHash, payload: {...facture ou vente...} }
app.post("/api/sales/:etwId/append", (req, res) => {
  const { etwId } = req.params;
  const { prevHash, payload } = req.body;

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "missing_payload" });
  }

  const result = withDB((db) => {
    if (!db.accounts[etwId]) return { accountMissing: true };
    if (!db.salesChain[etwId]) db.salesChain[etwId] = [];
    const chain = db.salesChain[etwId];

    const lastEntry = chain[chain.length - 1];
    const expectedPrevHash = lastEntry ? lastEntry.hash : "GENESIS";

    // Le client DOIT connaître le hash de la dernière ligne pour pouvoir
    // en ajouter une nouvelle — s'il ne correspond pas, soit le client a
    // une copie locale désynchronisée (à rafraîchir), soit une tentative
    // de falsification est en cours. Dans les deux cas : on rejette.
    if (String(prevHash || "GENESIS") !== expectedPrevHash) {
      return { chainBroken: true, expectedPrevHash };
    }

    const seq = chain.length + 1;
    const hash = computeChainHash(expectedPrevHash, payload);
    const entry = { seq, hash, prevHash: expectedPrevHash, payload, ts: serverNow() };
    chain.push(entry);
    return { entry };
  });

  if (result.accountMissing) return res.status(404).json({ error: "account_not_found" });
  if (result.chainBroken) {
    return res.status(409).json({
      error: "chain_broken",
      message: "Le hash précédent fourni ne correspond pas à la dernière écriture connue du serveur.",
      expectedPrevHash: result.expectedPrevHash
    });
  }
  return res.status(201).json(result.entry);
});

// Vérifie l'intégrité complète de la chaîne d'un compte — recalcule
// chaque hash depuis GENESIS et confirme qu'aucun maillon n'a été altéré.
app.get("/api/sales/:etwId/verify", (req, res) => {
  const db = loadDB();
  const chain = db.salesChain[req.params.etwId] || [];

  let expected = "GENESIS";
  for (const entry of chain) {
    if (entry.prevHash !== expected) {
      return res.json({ valid: false, brokenAtSeq: entry.seq, reason: "prevHash_mismatch" });
    }
    const recomputed = computeChainHash(entry.prevHash, entry.payload);
    if (recomputed !== entry.hash) {
      return res.json({ valid: false, brokenAtSeq: entry.seq, reason: "hash_mismatch" });
    }
    expected = entry.hash;
  }
  res.json({ valid: true, length: chain.length, lastHash: expected });
});

/* ============================================================================
   8. ANNONCES BOOSTÉES — lecture publique (utilisée par la Marketplace
      pour afficher le rail "Boutiques boostées" avec des données fraîches
      et vérifiées côté serveur, jamais déclarées par le client lui-même).
   ============================================================================ */
app.get("/api/ads/boosted", (req, res) => {
  const db = loadDB();
  const now = serverNow();
  const active = Object.entries(db.boostedAds)
    .filter(([, v]) => v.expiresAt > now)
    .map(([adId, v]) => ({ adId, expiresAt: v.expiresAt }));
  res.json({ boosted: active, serverTime: now });
});

/* ============================================================================
   9. ROUTES D'ADMINISTRATION — protégées par ETWAS_ADMIN_TOKEN.
      Utile pour un tableau de bord interne minimal (compter les comptes
      actifs, forcer une vérification de chaîne, etc.) sans exposer ces
      opérations publiquement.
   ============================================================================ */
app.get("/api/admin/accounts", requireAdmin, (req, res) => {
  const db = loadDB();
  res.json({ count: Object.keys(db.accounts).length, accounts: db.accounts });
});

/* ============================================================================
   10. DÉMARRAGE
   ============================================================================ */
app.listen(CONFIG.PORT, () => {
  console.log(`Etwas Server à l'écoute sur le port ${CONFIG.PORT}`);
  console.log(`Heure serveur (référence anti-triche) : ${new Date(serverNow()).toISOString()}`);
  if (!CONFIG.KKIAPAY_SECRET_KEY) console.warn("⚠️  KKIAPAY_SECRET_KEY absent — webhook KKiaPay désactivé.");
  if (!CONFIG.PLISIO_API_KEY) console.warn("⚠️  PLISIO_API_KEY absent — webhook Plisio désactivé.");
  if (!CONFIG.STRIPE_SECRET_KEY) console.warn("ℹ️  Stripe non configuré (en attente des clés DONKO UG).");
  if (!CONFIG.PAYPAL_CLIENT_ID) console.warn("ℹ️  PayPal non configuré (en attente des tokens).");
  if (!CONFIG.ADMIN_TOKEN) console.warn("⚠️  ETWAS_ADMIN_TOKEN absent — routes /api/admin/* désactivées.");
});

module.exports = app; // pour des tests automatisés éventuels (supertest, etc.)
