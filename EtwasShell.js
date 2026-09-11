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
var panels = {
  home: null,    // élément simple (div), pas une iframe — voir showTab()
  payment: null  // page de paiement unique — voir showTab()
};
var activeTab = "kalcul";

function $(id){ return document.getElementById(id); }

/* ----------------------------------------------------------
   Bascule d'onglet : on ne détruit jamais l'iframe inactive,
   on la masque seulement (visibility:hidden), ce qui préserve
   tout son état JS (panier en cours, formulaire en cours, etc.)
   Gère aussi le panneau "Accueil" (simple div, pas une iframe).
   ---------------------------------------------------------- */
function showTab(name){
  if(!frames[name] && !panels[name]) return;
  activeTab = name;
  Object.keys(frames).forEach(function(key){
    var iframe = frames[key];
    if(!iframe) return;
    iframe.classList.toggle("etwas-hidden", key !== name);
  });
  Object.keys(panels).forEach(function(key){
    var panel = panels[key];
    if(!panel) return;
    panel.classList.toggle("etwas-hidden", key !== name);
  });
  document.querySelectorAll("#etwasTabBar button").forEach(function(btn){
    btn.classList.toggle("active", btn.dataset.tab === name);
  });
  if(name === "payment" && typeof renderPayStatus === "function") renderPayStatus();
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
      if(msg.tab === "kalcul" || msg.tab === "marketplace" || msg.tab === "home" || msg.tab === "payment") showTab(msg.tab);
      break;
    case "etwas:request-payment":
      // Un module (Caisse ou Marketplace) demande à ouvrir la page de
      // paiement UNIQUE du shell — remplace l'ancien tunnel de paiement
      // interne de chaque module. sourceKey mémorisé pour savoir à qui
      // diffuser la confirmation d'activation une fois le paiement validé.
      lastPaymentRequestSource = sourceKey;
      showTab("payment");
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

/* ----------------------------------------------------------
   INSTALLATION PWA — UN SEUL point de capture pour toute
   l'application. Les modules internes (Caisse, Marketplace) ne
   gèrent plus leur propre invite d'installation (voir leur
   updateInstallUI/updateInstallBanner, désormais neutralisés
   quand ils tournent dans ce shell) : c'est ici, et ici
   seulement, qu'on écoute "beforeinstallprompt".
   ---------------------------------------------------------- */
var deferredInstallPrompt = null;

function isRunningStandalone(){
  return window.matchMedia && window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true; // iOS Safari
}

function initInstallButton(){
  var btn = $("etwasInstallBtn");
  if(!btn) return;

  if(isRunningStandalone()){
    btn.style.display = "none";
    return;
  }

  window.addEventListener("beforeinstallprompt", function(e){
    e.preventDefault();
    deferredInstallPrompt = e;
    btn.style.display = "inline-flex";
  });

  window.addEventListener("appinstalled", function(){
    deferredInstallPrompt = null;
    btn.style.display = "none";
  });

  btn.addEventListener("click", function(){
    if(deferredInstallPrompt){
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function(){ deferredInstallPrompt = null; });
    } else {
      // Chrome/Android n'a pas (encore) proposé l'évènement natif, ou on est
      // sur iOS/Safari qui ne le supporte pas du tout : on guide l'utilisateur.
      var ua = navigator.userAgent || "";
      var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      alert(isIOS
        ? "Sur iPhone/iPad (Safari) : appuyez sur Partager 📤 puis « Sur l'écran d'accueil »."
        : "Ouvrez le menu de votre navigateur (⋮ ou ...) puis choisissez « Installer l'application » ou « Ajouter à l'écran d'accueil »."
      );
    }
  });

  // Toujours visible dans le navigateur (même avant que l'évènement natif
  // n'arrive) pour que le bouton ne semble jamais "manquant" à l'utilisateur.
  btn.style.display = "inline-flex";
}

/* ============================================================
   PAGE DE PAIEMENT UNIQUE — un seul tunnel pour Etwas Pro ET
   Etwas ADS. Tarifs repris de la grille Etwas ADS (ex-DONKO ADS).
   Sur confirmation serveur (EtwasServer.js), diffuse l'activation
   aux DEUX modules par postMessage — chacun met à jour son propre
   état local avec ses fonctions existantes (activatePro / setAccess),
   sans qu'aucun des deux n'ait besoin de refaire sa propre
   vérification serveur.
   ============================================================ */
var lastPaymentRequestSource = null;
var FCFA_PER_EUR = 655.957; // parité fixe légale UEMOA/CEMAC
var PAY_PLANS = [
  { id:"trial",       label:"Essai complet",  days:30,    priceNew:656,    old:null,   badge:"1€ — 30 jours" },
  { id:"mensuel",     label:"Mensuel",        days:30,    priceNew:10838,  old:21675 },
  { id:"bimestriel",  label:"Bimestriel",     days:60,    priceNew:19465,  old:38930 },
  { id:"trimestriel", label:"Trimestriel",    days:90,    priceNew:27115,  old:54230 },
  { id:"semestriel",  label:"Semestriel",     days:180,   priceNew:48875,  old:97750 },
  { id:"annuel",      label:"Annuel",         days:365,   priceNew:80750,  old:161500, badge:"Meilleure offre" },
  { id:"2ans",        label:"2 ans",          days:730,   priceNew:135150, old:270300 },
  { id:"3ans",        label:"3 ans",          days:1095,  priceNew:177650, old:355300 },
  { id:"avie",        label:"À vie",          days:36500, priceNew:403750, old:807500, badge:"Offre exclusive" }
];
var selectedPayPlan = PAY_PLANS[0];

function fcfaFmt(n){ return n.toLocaleString("fr-FR") + " F CFA"; }

function renderPayPlans(){
  var grid = $("payPlansGrid");
  if(!grid) return;
  grid.innerHTML = PAY_PLANS.map(function(p){
    return '<div class="pay-plan' + (p.id===selectedPayPlan.id ? ' selected' : '') + '" data-id="' + p.id + '">' +
      (p.badge ? '<span class="pp-badge">' + p.badge + '</span>' : '') +
      '<div class="pp-label">' + p.label + '</div>' +
      (p.old ? '<span class="pp-old">' + fcfaFmt(p.old) + '</span>' : '') +
      '<span class="pp-new">' + fcfaFmt(p.priceNew) + '</span>' +
      '<div class="pp-days">' + (p.days>=36500 ? "Accès illimité" : p.days + " jours") + '</div>' +
    '</div>';
  }).join("");
  Array.prototype.forEach.call(grid.querySelectorAll(".pay-plan"), function(el){
    el.addEventListener("click", function(){
      selectedPayPlan = PAY_PLANS.filter(function(p){ return p.id === el.dataset.id; })[0];
      renderPayPlans();
    });
  });
}

function renderPayStatus(){
  var banner = $("payStatusBanner");
  if(!banner || typeof EtwasCloud === "undefined") return;
  var status = EtwasCloud.computeIsPremium();
  if(status.isPremium){
    banner.style.display = "block";
    banner.className = "pay-status";
    banner.textContent = "✅ Accès Premium actif sur Etwas Pro et Etwas ADS.";
  } else {
    banner.style.display = "block";
    banner.className = "pay-status locked";
    banner.textContent = "🔒 Aucun accès actif pour le moment — choisissez un plan ci-dessous.";
  }
}

function showPayMsg(text){
  var el = $("payMsg");
  if(el) el.textContent = text;
}

/* Diffuse l'activation confirmée aux deux modules. Chacun réutilise sa
   propre fonction existante (activatePro pour Etwas Pro, setAccess /
   vérification serveur pour Etwas ADS) via ce message — aucune
   duplication de logique métier ici. txnId (si le paiement est passé
   par KKiaPay) permet à Etwas ADS de faire re-vérifier la transaction
   par son propre serveur (Apps Script) et de réactiver les annonces
   suspendues — comme le faisait son ancien tunnel de paiement interne. */
function broadcastPremiumActivation(txnId){
  var payload = { type:"etwas:premium-activated", planId: selectedPayPlan.id, days: selectedPayPlan.days, priceNew: selectedPayPlan.priceNew, txnId: txnId || null };
  [frames.kalcul, frames.marketplace].forEach(function(f){
    if(f) try{ f.contentWindow.postMessage(payload, "*"); }catch(e){}
  });
}

function initPaymentPage(){
  renderPayPlans();

  $("payBackBtn").addEventListener("click", function(){
    showTab(lastPaymentRequestSource || "home");
  });

  $("payKkiapayBtn").addEventListener("click", function(){
    if(typeof openKkiapayWidget === "undefined"){
      showPayMsg("Module de paiement indisponible — vérifiez votre connexion.");
      return;
    }
    if(typeof EtwasCloud === "undefined" || !EtwasCloud.isConfigured()){
      showPayMsg("Serveur de paiement non configuré pour le moment.");
      return;
    }
    var etwId = EtwasCloud.getEtwId();
    var purpose = selectedPayPlan.id === "trial" ? "trial" : "subscription";
    openKkiapayWidget({
      amount: selectedPayPlan.priceNew,
      key: "5a2223a51cff4ee0029821e143a207f473f6f7f4", // clé PUBLIQUE KKiaPay (safe côté client)
      position: "center",
      theme: "#082045",
      data: JSON.stringify({ etwId: etwId, purpose: purpose, planId: selectedPayPlan.id }),
      name: "Client Etwas"
    });
  });

  if(typeof addSuccessListener !== "undefined"){
    addSuccessListener(function(response){
      var txnId = response && response.transactionId;
      showPayMsg("Paiement reçu — vérification en cours auprès du serveur...");
      EtwasCloud.pollForActivation({timeoutMs:25000, intervalMs:2000}).then(function(result){
        if(result.ok){
          showPayMsg("✅ Accès débloqué pour Etwas Pro et Etwas ADS !");
          renderPayStatus();
          broadcastPremiumActivation(txnId);
        } else {
          showPayMsg("La confirmation prend plus de temps que prévu — revenez sur cet onglet dans quelques instants.");
        }
      });
    });
  }
  if(typeof addFailedListener !== "undefined"){
    addFailedListener(function(){ showPayMsg("Paiement non abouti ou annulé. Aucun montant n'a été débité."); });
  }

  $("payPlisioBtn").addEventListener("click", function(){
    if(typeof EtwasCloud === "undefined" || !EtwasCloud.isConfigured()){
      showPayMsg("Serveur de paiement non configuré pour le moment.");
      return;
    }
    var etwId = EtwasCloud.getEtwId();
    var purpose = selectedPayPlan.id === "trial" ? "trial" : "subscription";
    var amountEUR = Math.round((selectedPayPlan.priceNew / FCFA_PER_EUR) * 100) / 100;
    showPayMsg("Création de la facture crypto...");
    fetch(EtwasCloud.getApiBase() + "/api/pay/create-plisio-invoice", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ etwId: etwId, purpose: purpose, planId: selectedPayPlan.id, amountEUR: amountEUR })
    }).then(function(r){ return r.json(); }).then(function(data){
      if(data.invoiceUrl){
        window.open(data.invoiceUrl, "_blank");
        showPayMsg("Facture Plisio ouverte dans un nouvel onglet — revenez ici une fois le paiement effectué.");
      } else {
        showPayMsg("Impossible de créer la facture Plisio pour le moment.");
      }
    }).catch(function(){ showPayMsg("Connexion au serveur de paiement impossible."); });
  });
}

function init(){
  frames.kalcul = $("frameKalcul");
  frames.marketplace = $("frameMarketplace");
  panels.home = $("etwasHome");
  panels.payment = $("etwasPayment");

  document.querySelectorAll("#etwasTabBar button").forEach(function(btn){
    btn.addEventListener("click", function(){ showTab(btn.dataset.tab); });
  });

  showTab("kalcul");
  updateSlogan("fr"); // Etwas Caisse démarre en français par défaut, comme ses modules
  initBoot();
  initInstallButton();
  initPaymentPage();
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
