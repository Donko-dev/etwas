/* ============================================================
   ETWAS SHELL — orchestrateur du conteneur unifié.
   Rôle strict de ce fichier (phase "Fusion des modules métier") :
     1. Basculer entre les deux modules (Caisse / Marketplace) sans
        jamais recharger leurs iframes — donc sans perte d'état.
     2. Relayer les messages inter-modules (postMessage) : un
        changement de thème/langue dans un module est répercuté
        dans l'autre ; une publication de produit Stock → Marketplace
        est transmise à l'iframe cible.
     3. Afficher un statut de connexion passif (jamais bloquant :
        les modules restent 100% utilisables hors ligne, ils gèrent
        eux-mêmes leur propre file d'attente).
   Ce fichier NE gère PAS (volontairement, ce sera une autre étape) :
     - l'identité unique ETW-XXXX-XXXX-XXXX (compte unique),
     - la synchronisation IndexedDB / Apps Script,
     - la logique d'abonnement Pro unifiée.
   ============================================================ */
(function(){
"use strict";

var frames = {
  kalcul: null,
  marketplace: null
};
var activeTab = "kalcul";

function $(id){ return document.getElementById(id); }

/* ----------------------------------------------------------
   Bascule d'onglet : on ne détruit jamais l'iframe inactive,
   on la masque seulement (visibility:hidden), ce qui préserve
   tout son état JS (panier en cours, formulaire en cours, etc.)
   ---------------------------------------------------------- */
function showTab(name){
  if(!frames[name]) return;
  activeTab = name;
  Object.keys(frames).forEach(function(key){
    var iframe = frames[key];
    if(!iframe) return;
    if(key === name){
      iframe.classList.remove("etwas-hidden");
    } else {
      iframe.classList.add("etwas-hidden");
    }
  });
  document.querySelectorAll("#etwasTabBar button").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
}

/* ----------------------------------------------------------
   Relais des messages entre modules. Chaque module poste un
   message à son window.parent (= ce shell) ; le shell le
   retransmet à l'AUTRE module. On ignore tout message dont
   l'origine ne correspond à aucune iframe connue, par prudence.
   ---------------------------------------------------------- */
window.addEventListener("message", function(ev){
  var msg = ev.data;
  if(!msg || typeof msg !== "object" || !msg.type) return;

  // Origine : quel module a émis le message ?
  var sourceKey = null;
  Object.keys(frames).forEach(function(key){
    if(frames[key] && frames[key].contentWindow === ev.source) sourceKey = key;
  });
  if(!sourceKey) return;

  switch(msg.type){
    case "etwas:theme-changed":
      broadcastToOthers(sourceKey, {type:"etwas:set-theme", theme: msg.theme});
      break;
    case "etwas:lang-changed":
      broadcastToOthers(sourceKey, {type:"etwas:set-lang", lang: msg.lang});
      updateSlogan(msg.lang);
      break;
    case "etwas:publish-product":
      // Le Stock (Caisse) demande à publier un produit sur la Marketplace.
      showTab("marketplace");
      if(frames.marketplace){
        // On laisse un court délai pour que l'iframe Marketplace, si elle vient
        // d'être révélée pour la première fois, ait fini son propre rendu initial.
        setTimeout(function(){
          frames.marketplace.contentWindow.postMessage(msg, "*");
        }, 50);
      }
      break;
    case "etwas:switch-tab":
      // Un module demande explicitement à afficher l'autre onglet
      // (ex. bouton "Etwas Pro" depuis la page d'accueil Marketplace).
      if(msg.tab === "kalcul" || msg.tab === "marketplace") showTab(msg.tab);
      break;
  }
});

function broadcastToOthers(sourceKey, payload){
  Object.keys(frames).forEach(function(key){
    if(key === sourceKey || !frames[key]) return;
    try{ frames[key].contentWindow.postMessage(payload, "*"); }catch(e){}
  });
}

/* ----------------------------------------------------------
   Slogan officiel — reste TOUJOURS affiché en anglais
   ("Own Your Commerce.") dans l'interface, pour asseoir
   l'identité internationale de la marque (voir cahier des
   charges branding). Seule la petite légende sous le logo,
   elle, peut refléter la langue active choisie dans les
   modules — un clin d'œil traduit, pas un remplacement.
   ---------------------------------------------------------- */
var SLOGAN_TRANSLATIONS = {
  fr: "Own Your Commerce. — Possédez votre commerce.",
  en: "Own Your Commerce.",
  de: "Own Your Commerce. — Ihr Handel, Ihre Kontrolle."
};
function updateSlogan(lang){
  var el = $("brandSlogan");
  if(!el) return;
  el.textContent = SLOGAN_TRANSLATIONS[lang] || SLOGAN_TRANSLATIONS.fr;
}

/* ----------------------------------------------------------
   Statut de connexion — purement informatif. Les modules sont
   Local-First : ils ne dépendent JAMAIS de cet indicateur pour
   fonctionner. On ne recharge jamais une iframe au retour de
   connexion (ça ferait perdre l'état en cours) — on se contente
   de mettre à jour la pastille, et chaque module gère lui-même
   sa propre reprise réseau (taux de change, file d'attente...).
   ---------------------------------------------------------- */
function updateConnStatus(){
  var el = $("etwasConnStatus");
  if(!el) return;
  if(navigator.onLine){
    el.classList.remove("offline");
    el.innerHTML = '<span class="dot"></span><span data-i18n-conn>En ligne</span>';
  } else {
    el.classList.add("offline");
    el.innerHTML = '<span class="dot"></span><span data-i18n-conn>Hors connexion — vos données restent disponibles</span>';
  }
}

/* ----------------------------------------------------------
   Démarrage : on attend que les DEUX iframes aient signalé leur
   chargement (évènement "load" natif) avant de retirer l'écran
   de démarrage, pour éviter un flash de contenu vide.
   ---------------------------------------------------------- */
function initBoot(){
  var pending = 2;
  function ready(){
    pending -= 1;
    if(pending <= 0){
      var boot = $("etwasBoot");
      if(boot) boot.classList.add("etwas-hidden");
    }
  }
  frames.kalcul.addEventListener("load", ready, {once:true});
  frames.marketplace.addEventListener("load", ready, {once:true});
  // Filet de sécurité : si un module met trop de temps (connexion très lente
  // au tout premier chargement), on ne bloque pas l'utilisateur indéfiniment.
  setTimeout(function(){ var boot = $("etwasBoot"); if(boot) boot.classList.add("etwas-hidden"); }, 6000);
}

function init(){
  frames.kalcul = $("frameKalcul");
  frames.marketplace = $("frameMarketplace");

  document.querySelectorAll("#etwasTabBar button").forEach(function(btn){
    btn.addEventListener("click", function(){ showTab(btn.dataset.tab); });
  });

  showTab("kalcul");
  updateSlogan("fr"); // Etwas Caisse démarre en français par défaut, comme ses modules
  initBoot();
  updateConnStatus();
  window.addEventListener("online", updateConnStatus);
  window.addEventListener("offline", updateConnStatus);
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

/* Enregistrement du Service Worker unifié — un seul, au niveau du shell,
   qui couvre le shell ET les deux modules (mêmes origine et scope). */
if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js").catch(function(){
      /* échec silencieux (ex. navigateur sans support) — l'app reste
         utilisable, simplement sans mise en cache avancée hors ligne */
    });
  });
}

})();
