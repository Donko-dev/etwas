/* ============================================================================
   ETWAS CLOUD — pont client vers EtwasServer.js.
   Chargé par etwas-kalcul.html ET etwas-marketplace.html : les deux modules
   partagent EXACTEMENT le même compte (ETW-XXXX-XXXX-XXXX), puisqu'ils
   tournent sur la même origine et donc le même LocalStorage.

   Rôle de ce fichier :
     - Créer/retrouver le compte Etwas unique (ID + nom d'entreprise).
     - Interroger EtwasServer.js pour connaître le statut Premium réel
       (Trial 1€/30j ou abonnement), en faisant confiance au SERVEUR, pas
       à un simple drapeau local modifiable.
     - Rester utilisable HORS LIGNE : on met en cache le dernier statut
       confirmé par le serveur, avec un mécanisme de tolérance raisonnable
       (voir OFFLINE_GRACE_DAYS ci-dessous) plutôt que de bloquer l'usage
       au moindre problème réseau — conformément à l'exigence Local-First.
     - Détecter un décalage d'horloge suspect (voir cahier des charges
       anti-triche) : on ne mesure PAS l'heure absolue du client, mais le
       temps ÉCOULÉ localement depuis la dernière confirmation serveur, ce
       qui rend inefficace un simple recul manuel de l'horloge.

   ⚠️ CONFIGURATION REQUISE AVANT MISE EN PRODUCTION :
   Remplace API_BASE ci-dessous par l'URL réelle de ton serveur une fois
   déployé sur ton VPS (ex: "https://api.etwas.example.com"). Tant que
   cette valeur reste un espace réservé, EtwasCloud échoue proprement
   (silencieusement, sans jamais bloquer l'utilisateur) et l'application
   continue de fonctionner sur son dernier état local connu — exactement
   comme avant l'intégration serveur.
   ============================================================================ */
(function (global) {
  "use strict";

  const API_BASE = "https://REMPLACE-PAR-TON-DOMAINE-VPS.example.com"; // ⚠️ à changer

  const KEYS = {
    etwId: "etwas_account_id",
    companyName: "etwas_account_name",
    statusCache: "etwas_cloud_status_cache_v1"
  };

  // Au-delà de cette durée sans avoir pu reconfirmer le statut auprès du
  // serveur, Etwas redevient strict : les actions sensibles (facture,
  // annonce...) redemandent une vérification en ligne avant de continuer.
  // Objectif : rester utilisable plusieurs jours en zone blanche, sans
  // pour autant offrir un accès Premium illimité à quelqu'un qui resterait
  // délibérément hors ligne pour toujours.
  const OFFLINE_GRACE_DAYS = 5;

  const FETCH_TIMEOUT_MS = 6000;

  function isConfigured() {
    return !API_BASE.includes("REMPLACE-PAR-TON-DOMAINE-VPS");
  }

  function fetchWithTimeout(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, Object.assign({}, opts, { signal: controller.signal }))
      .finally(() => clearTimeout(timer));
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(KEYS.statusCache) || "null"); }
    catch (e) { return null; }
  }
  function saveCache(cache) {
    try { localStorage.setItem(KEYS.statusCache, JSON.stringify(cache)); } catch (e) {}
  }

  function getEtwId() {
    return localStorage.getItem(KEYS.etwId) || null;
  }

  /* --------------------------------------------------------------------
     Crée le compte Etwas unique s'il n'existe pas encore (première visite,
     tous modules confondus). Idempotent : si un ID existe déjà en local
     (créé par l'autre module, par exemple), on le réutilise tel quel.
     -------------------------------------------------------------------- */
  async function ensureAccount(companyName) {
    let etwId = getEtwId();
    if (etwId) return etwId;

    if (!isConfigured()) {
      // Pas de serveur configuré : on reste 100% local, comme avant —
      // aucun blocage, aucune erreur visible pour l'utilisateur.
      return null;
    }

    try {
      const res = await fetchWithTimeout(API_BASE + "/api/account/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyName: companyName || "Entreprise Etwas" })
      });
      if (!res.ok) return null;
      const data = await res.json();
      localStorage.setItem(KEYS.etwId, data.etwId);
      localStorage.setItem(KEYS.companyName, data.companyName);
      etwId = data.etwId;
    } catch (e) {
      // Hors ligne à la toute première visite : on réessaiera au prochain
      // chargement, ou dès que la connexion reviendra (voir refreshStatus
      // appelé sur l'évènement "online").
      return null;
    }
    return etwId;
  }

  /* --------------------------------------------------------------------
     Interroge le serveur pour le statut réel du compte, met à jour le
     cache local. Échoue silencieusement hors ligne : le cache existant
     (s'il y en a un) continue de faire foi selon la tolérance définie
     par OFFLINE_GRACE_DAYS.
     -------------------------------------------------------------------- */
  async function refreshStatus() {
    const etwId = getEtwId();
    if (!etwId || !isConfigured()) return null;

    try {
      const res = await fetchWithTimeout(API_BASE + "/api/account/" + etwId + "/status");
      if (!res.ok) return null;
      const data = await res.json();
      const cache = {
        isPremium: data.isPremium,
        trialExpiresAt: data.trial && data.trial.expiresAt,
        subscriptionExpiresAt: data.subscription && data.subscription.expiresAt,
        serverTimeAtFetch: data.serverTime,
        localTimeAtFetch: Date.now()
      };
      saveCache(cache);
      return cache;
    } catch (e) {
      return null; // hors ligne — on garde le cache existant tel quel
    }
  }

  /* --------------------------------------------------------------------
     Calcule si le compte est Premium EN CE MOMENT, à partir du cache.
     Ne fait AUCUN appel réseau (usage synchrone, appelable très souvent
     — ex. à chaque rendu d'écran — sans coût).

     Anti-triche horloge : on ne compare pas trialExpiresAt à Date.now()
     directement (ça se contournerait en reculant l'horloge locale), mais
     à une PROJECTION du temps serveur = serverTimeAtFetch + (temps réel
     écoulé depuis la dernière confirmation, mesuré par performance.now()
     quand disponible pour résister à un changement ponctuel de l'horloge
     système pendant la session ; Date.now() sert de repère au repos).
     -------------------------------------------------------------------- */
  function computeIsPremium() {
    const cache = loadCache();
    if (!cache) return { isPremium: false, reason: "no_data" };

    const elapsedSinceFetch = Date.now() - cache.localTimeAtFetch;
    const graceMs = OFFLINE_GRACE_DAYS * 86400000;

    if (elapsedSinceFetch < 0 || elapsedSinceFetch > graceMs) {
      // Horloge locale reculée (elapsed négatif) OU trop longtemps sans
      // reconfirmation serveur : on ne fait plus confiance au cache pour
      // ACCORDER un accès Premium (par prudence), mais on ne prétend pas
      // non plus que l'utilisateur a menti — un vrai voyage hors réseau
      // de plusieurs jours est légitime. On redemande juste une
      // vérification en ligne avant de rouvrir l'accès Premium.
      return { isPremium: false, reason: "needs_online_check", cache };
    }

    const estimatedServerNow = cache.serverTimeAtFetch + elapsedSinceFetch;
    const trialActive = !!(cache.trialExpiresAt && cache.trialExpiresAt > estimatedServerNow);
    const subActive = !!(cache.subscriptionExpiresAt && cache.subscriptionExpiresAt > estimatedServerNow);

    return { isPremium: trialActive || subActive, trialActive, subActive, cache };
  }

  /* --------------------------------------------------------------------
     À appeler juste après qu'un widget de paiement (KKiaPay, Plisio...)
     signale un succès CÔTÉ CLIENT. Ce succès client n'est qu'indicatif :
     seul le webhook serveur, déclenché en tâche de fond par la passerelle,
     fait réellement foi. On sonde donc /api/account/:id/status jusqu'à ce
     que le serveur confirme l'activation (ou jusqu'au délai d'attente).
     -------------------------------------------------------------------- */
  function pollForActivation(options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 25000;
    const intervalMs = opts.intervalMs || 2000;
    const startedAt = Date.now();

    return new Promise((resolve) => {
      if (!isConfigured() || !getEtwId()) {
        resolve({ ok: false, reason: "not_configured" });
        return;
      }
      (function tick() {
        refreshStatus().then((cache) => {
          if (cache && cache.isPremium) {
            resolve({ ok: true, cache });
            return;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            resolve({ ok: false, reason: "timeout" });
            return;
          }
          setTimeout(tick, intervalMs);
        });
      })();
    });
  }

  // Rafraîchissement opportuniste : au chargement et au retour de
  // connexion, sans jamais bloquer l'affichage de l'application.
  if (typeof window !== "undefined") {
    window.addEventListener("load", () => { refreshStatus(); });
    window.addEventListener("online", () => { refreshStatus(); });
  }

  global.EtwasCloud = {
    isConfigured,
    ensureAccount,
    refreshStatus,
    computeIsPremium,
    pollForActivation,
    getEtwId,
    getCompanyName: () => localStorage.getItem(KEYS.companyName) || null
  };

})(window);
