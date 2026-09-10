/* ============================================================
   ETWAS — Service Worker unifié.
   Rôle : garantir que le shell ET les deux modules (Caisse,
   Marketplace) se rechargent correctement même hors connexion,
   y compris après une actualisation (F5) ou une fermeture
   complète de l'application — jamais de page d'erreur de
   connexion, toujours la dernière version connue qui s'affiche.

   Stratégie : "stale-while-revalidate" sur toutes les ressources
   de même origine (le shell, les deux iframes de modules, leurs
   scripts/styles/icônes). La ressource en cache est servie
   IMMÉDIATEMENT (disponible hors ligne dès la première visite en
   ligne), pendant qu'une tentative de mise à jour silencieuse se
   fait en arrière-plan si une connexion est disponible.

   Les appels vers des domaines tiers (KKiaPay, Plisio, Stripe,
   PayPal, Google Apps Script, taux de change) ne sont JAMAIS
   interceptés : ils suivent leur propre logique réseau native,
   avec échec silencieux déjà géré côté application (files
   d'attente locales dans chaque module).

   Pour publier une mise à jour d'Etwas plus tard : changer
   CACHE_NAME (ex. "etwas-cache-v2") force le renouvellement du
   cache chez tous les utilisateurs déjà installés.
   ============================================================ */

const CACHE_NAME = "etwas-cache-v1";

// Coquille minimale pré-cachée à l'installation, pour que le tout
// premier lancement hors connexion (juste après l'installation PWA)
// fonctionne déjà. Le reste se cache au fil de la navigation normale.
const PRECACHE_URLS = [
  "./",
  "index.html",
  "EtwasShell.js",
  "EtwasShell.css",
  "manifest.json",
  "etwas-kalcul.html",
  "etwas-marketplace.html",
  "icon-192.png",
  "icon-512.png",
  "favicon.ico",
  "apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => {
        // Si une ressource manque au moment du build (ex. favicon pas encore
        // fourni), on n'empêche pas l'installation du Service Worker pour
        // autant : le cache se remplira progressivement via le fetch normal.
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // On ne met en cache que les requêtes GET de notre propre origine.
  // Tout le reste (passerelles de paiement, Apps Script, taux de
  // change, polices Google, CDN KKiaPay...) suit son comportement
  // réseau natif, sans interception — chaque module gère déjà
  // proprement ses propres échecs réseau (file d'attente, cache local).
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation de page (ex. F5 sur index.html) : on répond aussi en
  // stale-while-revalidate plutôt qu'un mode "network-first" classique,
  // pour que l'écran ne clignote jamais vers une page d'erreur si la
  // connexion vient de tomber pile au moment du rechargement.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached); // hors ligne ou échec réseau : retombe sur le cache

        // Sert le cache immédiatement s'il existe (rapide + fiable hors
        // ligne, jamais d'écran d'erreur) ; sinon attend la réponse
        // réseau (cas du tout premier chargement, en ligne).
        return cached || networkFetch;
      })
    )
  );
});

/* ============================================================
   Relais de reprise réseau : quand la connexion revient, chaque
   module (Caisse, Marketplace) écoute déjà l'évènement natif
   "online" dans sa propre page pour relancer sa file d'attente et
   rafraîchir ses données distantes — ce Service Worker n'a donc
   pas besoin de forcer un rechargement de page, ce qui éviterait
   justement de perdre un panier ou un formulaire en cours.
   ============================================================ */
