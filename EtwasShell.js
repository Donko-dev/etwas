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
    case "etwas:boosted-shops":
      // Etwas ADS a fini de charger ses données et nous transmet la liste
      // des boutiques actuellement boostées — la page d'accueil ne refait
      // jamais cette requête elle-même, elle réutilise ce que le module a
      // déjà récupéré.
      if(Array.isArray(msg.shops)) renderBoostedHome(msg.shops);
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
/* ============================================================
   PAGE D'ACCUEIL — moteur trilingue, navigation, actualités datées,
   et pont vers les boutiques boostées d'Etwas ADS.
   Le FRANÇAIS est déjà écrit en dur dans index.html (data-i18n sert
   de référence de clé) — seuls l'anglais et l'allemand sont traduits
   ici et appliqués par-dessus au changement de langue.
   ============================================================ */
var HOME_I18N = { en: {}, de: {} };

HOME_I18N.en = {
  h_slogan: "<em>Own Your Commerce.</em>",
  h_hero_title: "The sovereign, local-first ecosystem to own your entire business.",
  h_hero_lede: "Etwas brings together, in one single app, what elsewhere takes ten different tools: a professional register (<strong>Etwas Pro</strong>) and a worldwide marketplace (<strong>Etwas ADS</strong>), running 100% offline, with no sign-up and no password.",
  h_install_btn: "📲 Install Etwas on this device",
  h_hero_link_pro: "🧾 Discover Etwas Pro",
  h_hero_link_ads: "🛍️ Discover Etwas ADS",
  h_boosted_eyebrow: "FEATURED",
  h_boosted_title: "Boosted shops on Etwas ADS",
  h_boosted_intro: "Only shops with an active <strong>Boost</strong> appear here, sorted by category — it's the only showcase of this kind Etwas offers: a seller who invests in their visibility gets featured in front of everyone, right from the home page.",
  h_boosted_empty: "No boosted shop yet — open the Marketplace tab to be the first one featured here.",
  h_pro_eyebrow: "PRODUCT 1 — THE REGISTER",
  h_pro_title: "Etwas Pro — your register, your stock, your invoices.",
  h_pro_intro: "<em>Etwas Pro</em> is Etwas's business management module: point of sale, stock management, professional invoicing and sales history, built to run <strong>100% offline</strong>. No customer data, no invoice, no product is ever sent to a server: everything stays on the merchant's device.",
  h_pro_f1_t: "🧾 Register (POS)",
  h_pro_f1_d: "Fast checkout straight from your Stock: search by name or reference, or scan a barcode with your phone's camera to add a product to the cart in one gesture. The receipt is generated instantly.",
  h_pro_f1_a: "<strong>Access:</strong> Register tab → search bar or the 📷 button.",
  h_pro_f2_t: "📦 Stock",
  h_pro_f2_d: "Add your products with purchase price, selling price, quantity and several photos. Etwas automatically computes your margin. Any product sheet can be published to Etwas ADS in a single click — see the fusion section below.",
  h_pro_f2_a: "<strong>Access:</strong> Stock tab → \"Add a product\".",
  h_pro_f3_t: "📄 Invoices & Quotes",
  h_pro_f3_d: "Professional A4 editor, your company logo, automatic tax calculation, PDF export ready to send. Premium documents receive a discreet anti-counterfeiting watermark.",
  h_pro_f3_a: "<strong>Access:</strong> Document tab → Invoice or Quote.",
  h_pro_f4_t: "📊 History",
  h_pro_f4_d: "All your sales and generated documents, sorted by date, available to view and reprint at any time — even without an internet connection.",
  h_pro_f4_a: "<strong>Access:</strong> History tab.",
  h_pro_f5_t: "🔒 Security & Backup",
  h_pro_f5_d: "Lock the app with a personal code, and export a complete JSON backup to switch phones without ever losing a single piece of data.",
  h_pro_f5_a: "<strong>Access:</strong> More → Settings → Security / Backup.",
  h_pro_f6_t: "📈 GoBD Chain",
  h_pro_f6_d: "Every sale is cryptographically chained to the previous one: no entry can be modified or discreetly inserted afterwards — real accounting immutability, not just a promise.",
  h_pro_f6_a: "<strong>Advantage:</strong> compliance and trust, with zero effort on your part.",
  h_pro_cta: "→ Open Etwas Pro now",
  h_ads_eyebrow: "PRODUCT 2 — THE MARKETPLACE",
  h_ads_title: "Etwas ADS — your shop, seen by everyone.",
  h_ads_intro: "<em>Etwas ADS</em> is Etwas's worldwide marketplace: every merchant creates their shop and publishes listings there — physical products as well as digital services — visible to buyers everywhere, with a proximity filter to favor local commerce when it matters.",
  h_ads_f1_t: "🏪 Create your shop",
  h_ads_f1_d: "Name, category, city, logo, and an optional geographic position — so buyers near you can find you through the \"Near me\" filter.",
  h_ads_f2_t: "📣 Publish a listing",
  h_ads_f2_d: "Up to 10 photos, rich description, price displayable in any currency (automatic conversion), and a direct WhatsApp contact for the buyer.",
  h_ads_f3_t: "🔍 Discover",
  h_ads_f3_d: "Instant search, categories, sorting by relevance or by distance (Haversine formula computed locally — your position is never sent to a server).",
  h_ads_f4_t: "⚡ 1-Click Express Purchase",
  h_ads_f4_d: "A pre-filled WhatsApp message goes straight to the seller, with the listing reference and the price already converted to your currency — no form to fill in.",
  h_ads_f5_t: "🚀 Boost your shop",
  h_ads_f5_d: "31 days of priority placement in results, and a guaranteed spot in the \"Boosted shops\" section of this home page — Etwas's most visible showcase.",
  h_ads_f6_t: "🔗 Fusion with Etwas Pro",
  h_ads_f6_d: "A merchant already using Etwas Pro can publish any Stock product to Etwas ADS in a single click, without retyping the description or photos — the two worlds communicate in real time.",
  h_ads_cta: "→ Open Etwas ADS now",
  h_pricing_eyebrow: "ONE PAYMENT, ALL OF ETWAS",
  h_pricing_title: "Simple pricing, full access.",
  h_pricing_intro: "A single payment unlocks <strong>both Etwas Pro AND Etwas ADS</strong> at once — never two separate subscriptions. Pay via KKiaPay (Mobile Money, Visa/Mastercard) or Plisio (crypto: USDT, BTC...); Stripe and PayPal arrive with activation in Europe.",
  h_price_trial_t: "Full trial — €1 / 656 F CFA",
  h_price_trial_d: "30 days of total, unlimited access, with no restriction at all. The ideal entry point to judge for yourself.",
  h_price_month_t: "Monthly to Half-yearly",
  h_price_month_d: "From 10,838 to 48,875 F CFA — for a business just starting out, or testing Etwas over time without a long commitment.",
  h_price_year_t: "Yearly to 3 years",
  h_price_year_d: "From 80,750 to 177,650 F CFA — the best price-per-day ratio, designed for already-established businesses.",
  h_price_life_t: "Lifetime — 403,750 F CFA",
  h_price_life_d: "One single payment, never another deadline again. The preferred option for entrepreneurs thinking long term.",
  h_price_cta: "→ See all pricing in detail",
  h_news_eyebrow: "ETWAS NEWS",
  h_news_title: "What's evolving in the Register, Stock and Marketplace tools.",
  h_news_intro: "This section updates as Etwas evolves — a new entry appears automatically on its publication date, with no app update required to see it.",
  h_about_eyebrow: "OUR STORY",
  h_about_title: "Why Etwas exists.",
  h_about_p1: "Etwas was born from the merger of two independent tools — <strong>Kalcul Pro</strong>, a local register built to run without reliable internet, and <strong>DONKO ADS</strong>, a marketplace designed to give a worldwide showcase to merchants often confined to their own neighborhood. Both were run by <strong>Empire Donko</strong>, registered under the name <strong>TransTech Dynamic</strong> in Benin.",
  h_about_p2: "The founding intuition is simple: a merchant shouldn't have to choose between \"selling well locally\" and \"existing internationally.\" Etwas brings both together in a single app, <em>local-first</em> by design — it runs on the device first, with connectivity only an occasional bridge to everything else.",
  h_about_p3: "The ecosystem is currently transitioning to <strong>DONKO UG (haftungsbeschränkt)</strong>, a German company being incorporated, which will eventually carry the entire Etwas brand. Until this entity is officially registered, Empire Donko (TransTech Dynamic) remains the sole legally responsible publisher of the app — see the Legal Notice for the exact details.",
  h_about_p4: "Our ambition by <strong>2031</strong>: make Etwas a global commerce ecosystem where every seller keeps full ownership of their data, where anonymity (zero email, zero password) is the norm rather than the exception, and where the same app serves a neighborhood shop as well as a company selling across continents.",
  hf_col1_t: "Etwas Pro", hf_col1_l1: "Register (POS)", hf_col1_l2: "Stock Management", hf_col1_l3: "Invoices & Quotes", hf_col1_l4: "Sales History",
  hf_col2_t: "Etwas ADS", hf_col2_l1: "Create my shop", hf_col2_l2: "Publish a listing", hf_col2_l3: "Boost my visibility", hf_col2_l4: "Search near me",
  hf_col3_t: "Account & Access", hf_col3_l1: "Pricing & payment", hf_col3_l2: "Full Etwas guide", hf_col3_l3: "Legal notice", hf_col3_l4: "Terms of use",
  hf_col4_t: "Partnership",
  footer_partner_s: "A custom tool idea for your business? Write to us.",
  hf_legal: "Etwas is published by Empire Donko (TransTech Dynamic), Benin — transitioning to DONKO UG (Germany). See the Legal Notice for the exact responsible entity.",
  hf_brand: "ETWAS", hf_tagline: "Own Your Commerce.", powered_by: "Powered by"
};

HOME_I18N.de = {
  h_slogan: "<em>Own Your Commerce.</em> — <em>Ihr Handel, Ihre Kontrolle.</em>",
  h_hero_title: "Das souveräne, lokal-first Ökosystem, um Ihr gesamtes Geschäft zu besitzen.",
  h_hero_lede: "Etwas vereint in einer einzigen App, wofür anderswo zehn verschiedene Tools nötig sind: eine professionelle Kasse (<strong>Etwas Pro</strong>) und einen weltweiten Marktplatz (<strong>Etwas ADS</strong>) — zu 100% offline, ohne Registrierung, ohne Passwort.",
  h_install_btn: "📲 Etwas auf diesem Gerät installieren",
  h_hero_link_pro: "🧾 Etwas Pro entdecken",
  h_hero_link_ads: "🛍️ Etwas ADS entdecken",
  h_boosted_eyebrow: "IM BLICKPUNKT",
  h_boosted_title: "Beworbene Geschäfte auf Etwas ADS",
  h_boosted_intro: "Nur Geschäfte mit aktivem <strong>Boost</strong> erscheinen hier, nach Kategorie sortiert — das ist das einzige Schaufenster dieser Art bei Etwas: Ein Verkäufer, der in seine Sichtbarkeit investiert, wird direkt auf der Startseite allen gezeigt.",
  h_boosted_empty: "Noch kein beworbenes Geschäft — öffnen Sie den Marketplace-Tab, um als Erste(r) hier zu erscheinen.",
  h_pro_eyebrow: "PRODUKT 1 — DIE KASSE",
  h_pro_title: "Etwas Pro — Ihre Kasse, Ihr Lager, Ihre Rechnungen.",
  h_pro_intro: "<em>Etwas Pro</em> ist das Geschäftsverwaltungsmodul von Etwas: Kasse, Lagerverwaltung, professionelle Rechnungsstellung und Verkaufshistorie — konzipiert für <strong>100% Offline-Betrieb</strong>. Keine Kundendaten, keine Rechnung, kein Produkt wird jemals an einen Server gesendet: Alles bleibt auf dem Gerät des Händlers.",
  h_pro_f1_t: "🧾 Kasse (POS)",
  h_pro_f1_d: "Schneller Verkauf direkt aus Ihrem Lager: Suche nach Name oder Referenz, oder Barcode-Scan mit der Handykamera, um ein Produkt in einer Geste zum Warenkorb hinzuzufügen. Der Bon wird sofort erstellt.",
  h_pro_f1_a: "<strong>Zugang:</strong> Kasse-Tab → Suchleiste oder 📷-Taste.",
  h_pro_f2_t: "📦 Lager",
  h_pro_f2_d: "Fügen Sie Produkte mit Einkaufspreis, Verkaufspreis, Menge und mehreren Fotos hinzu. Etwas berechnet automatisch Ihre Marge. Jedes Produkt kann mit einem Klick auf Etwas ADS veröffentlicht werden — siehe Fusion weiter unten.",
  h_pro_f2_a: "<strong>Zugang:</strong> Lager-Tab → „Produkt hinzufügen“.",
  h_pro_f3_t: "📄 Rechnungen & Angebote",
  h_pro_f3_d: "Professioneller A4-Editor, Ihr Firmenlogo, automatische Steuerberechnung, PDF-Export versandfertig. Premium-Dokumente erhalten ein dezentes Wasserzeichen gegen Fälschung.",
  h_pro_f3_a: "<strong>Zugang:</strong> Dokument-Tab → Rechnung oder Angebot.",
  h_pro_f4_t: "📊 Verlauf",
  h_pro_f4_d: "Alle Ihre Verkäufe und erstellten Dokumente, nach Datum sortiert, jederzeit einsehbar und erneut druckbar — auch ohne Internetverbindung.",
  h_pro_f4_a: "<strong>Zugang:</strong> Verlauf-Tab.",
  h_pro_f5_t: "🔒 Sicherheit & Sicherung",
  h_pro_f5_d: "Sperren Sie die App mit einem persönlichen Code und exportieren Sie eine vollständige JSON-Sicherung, um das Telefon zu wechseln, ohne je Daten zu verlieren.",
  h_pro_f5_a: "<strong>Zugang:</strong> Mehr → Einstellungen → Sicherheit / Sicherung.",
  h_pro_f6_t: "📈 GoBD-Kette",
  h_pro_f6_d: "Jeder Verkauf ist kryptografisch mit dem vorherigen verkettet: Kein Eintrag kann nachträglich geändert oder heimlich eingefügt werden — echte buchhalterische Unveränderlichkeit, kein bloßes Versprechen.",
  h_pro_f6_a: "<strong>Vorteil:</strong> Compliance und Vertrauen, ganz ohne Ihr Zutun.",
  h_pro_cta: "→ Etwas Pro jetzt öffnen",
  h_ads_eyebrow: "PRODUKT 2 — DER MARKTPLATZ",
  h_ads_title: "Etwas ADS — Ihr Geschäft, von allen gesehen.",
  h_ads_intro: "<em>Etwas ADS</em> ist der weltweite Marktplatz von Etwas: Jeder Händler erstellt dort sein Geschäft und veröffentlicht Anzeigen — physische Produkte ebenso wie digitale Dienstleistungen —, sichtbar für Käufer überall, mit einem Nähe-Filter, um lokalen Handel zu bevorzugen, wenn es sinnvoll ist.",
  h_ads_f1_t: "🏪 Geschäft erstellen",
  h_ads_f1_d: "Name, Kategorie, Stadt, Logo und optional ein geografischer Standort — damit Käufer in Ihrer Nähe Sie über den Filter „In meiner Nähe“ finden können.",
  h_ads_f2_t: "📣 Anzeige veröffentlichen",
  h_ads_f2_d: "Bis zu 10 Fotos, ausführliche Beschreibung, Preis in beliebiger Währung anzeigbar (automatische Umrechnung) und direkter WhatsApp-Kontakt für den Käufer.",
  h_ads_f3_t: "🔍 Entdecken",
  h_ads_f3_d: "Sofortsuche, Kategorien, Sortierung nach Relevanz oder Entfernung (lokal berechnete Haversine-Formel — Ihr Standort wird nie an einen Server gesendet).",
  h_ads_f4_t: "⚡ 1-Klick-Express-Kauf",
  h_ads_f4_d: "Eine vorausgefüllte WhatsApp-Nachricht geht direkt an den Verkäufer, mit Anzeigenreferenz und bereits in Ihre Währung umgerechnetem Preis — ganz ohne Formular.",
  h_ads_f5_t: "🚀 Geschäft boosten",
  h_ads_f5_d: "31 Tage bevorzugte Platzierung in den Ergebnissen und ein garantierter Platz im Bereich „Beworbene Geschäfte“ dieser Startseite — Etwas' sichtbarstes Schaufenster.",
  h_ads_f6_t: "🔗 Fusion mit Etwas Pro",
  h_ads_f6_d: "Ein Händler, der bereits Etwas Pro nutzt, kann jedes Lagerprodukt mit einem Klick auf Etwas ADS veröffentlichen, ohne Beschreibung oder Fotos neu einzugeben — beide Welten kommunizieren in Echtzeit.",
  h_ads_cta: "→ Etwas ADS jetzt öffnen",
  h_pricing_eyebrow: "EINE ZAHLUNG, GANZ ETWAS",
  h_pricing_title: "Einfache Preise, voller Zugang.",
  h_pricing_intro: "Eine einzige Zahlung schaltet <strong>sowohl Etwas Pro als auch Etwas ADS</strong> gleichzeitig frei — nie zwei getrennte Abonnements. Zahlung per KKiaPay (Mobile Money, Visa/Mastercard) oder Plisio (Krypto: USDT, BTC...); Stripe und PayPal kommen mit der Aktivierung in Europa.",
  h_price_trial_t: "Kompletter Test — 1 € / 656 F CFA",
  h_price_trial_d: "30 Tage vollen, unbegrenzten Zugang, ganz ohne Einschränkung. Der ideale Einstieg, um sich selbst ein Bild zu machen.",
  h_price_month_t: "Monatlich bis Halbjährlich",
  h_price_month_d: "Von 10.838 bis 48.875 F CFA — für ein startendes Geschäft oder um Etwas über einen Zeitraum zu testen, ohne langfristige Bindung.",
  h_price_year_t: "Jährlich bis 3 Jahre",
  h_price_year_d: "Von 80.750 bis 177.650 F CFA — das beste Preis-pro-Tag-Verhältnis, gedacht für bereits etablierte Geschäfte.",
  h_price_life_t: "Lebenslang — 403.750 F CFA",
  h_price_life_d: "Eine einzige Zahlung, nie wieder eine Frist. Die bevorzugte Option für langfristig denkende Unternehmer.",
  h_price_cta: "→ Alle Preise im Detail ansehen",
  h_news_eyebrow: "ETWAS NEUIGKEITEN",
  h_news_title: "Was sich bei Kasse-, Lager- und Marktplatz-Tools weiterentwickelt.",
  h_news_intro: "Dieser Bereich aktualisiert sich mit der Weiterentwicklung von Etwas — ein neuer Eintrag erscheint automatisch zu seinem Veröffentlichungsdatum, ohne dass ein App-Update nötig ist.",
  h_about_eyebrow: "UNSERE GESCHICHTE",
  h_about_title: "Warum es Etwas gibt.",
  h_about_p1: "Etwas entstand aus der Fusion zweier unabhängiger Tools — <strong>Kalcul Pro</strong>, eine lokale Kasse für den Betrieb ohne zuverlässiges Internet, und <strong>DONKO ADS</strong>, ein Marktplatz, der Händlern, die oft auf ihr eigenes Viertel beschränkt waren, ein weltweites Schaufenster geben sollte. Beide wurden von <strong>Empire Donko</strong> betrieben, eingetragen unter dem Namen <strong>TransTech Dynamic</strong> in Benin.",
  h_about_p2: "Die Gründungsidee ist einfach: Ein Händler sollte nicht zwischen „gut lokal verkaufen“ und „international existieren“ wählen müssen. Etwas vereint beides in einer App, die von Grund auf <em>lokal-first</em> ist — sie läuft zuerst auf dem Gerät, die Verbindung ist nur gelegentlich eine Brücke zu allem anderen.",
  h_about_p3: "Das Ökosystem befindet sich derzeit im Übergang zu <strong>DONKO UG (haftungsbeschränkt)</strong>, einer im Aufbau befindlichen deutschen Gesellschaft, die künftig die gesamte Marke Etwas tragen wird. Solange diese Gesellschaft nicht offiziell eingetragen ist, bleibt Empire Donko (TransTech Dynamic) der einzige rechtlich verantwortliche Herausgeber der App — Details siehe Impressum.",
  h_about_p4: "Unser Ziel bis <strong>2031</strong>: Etwas zu einem globalen Handelsökosystem machen, in dem jeder Verkäufer die volle Kontrolle über seine Daten behält, in dem Anonymität (null E-Mail, null Passwort) die Regel statt der Ausnahme ist, und in dem dieselbe App sowohl einem Nachbarschaftsladen als auch einem auf mehreren Kontinenten verkaufenden Unternehmen dient.",
  hf_col1_t: "Etwas Pro", hf_col1_l1: "Kasse (POS)", hf_col1_l2: "Lagerverwaltung", hf_col1_l3: "Rechnungen & Angebote", hf_col1_l4: "Verkaufshistorie",
  hf_col2_t: "Etwas ADS", hf_col2_l1: "Mein Geschäft erstellen", hf_col2_l2: "Anzeige veröffentlichen", hf_col2_l3: "Sichtbarkeit boosten", hf_col2_l4: "In meiner Nähe suchen",
  hf_col3_t: "Konto & Zugang", hf_col3_l1: "Preise & Zahlung", hf_col3_l2: "Vollständiger Etwas-Leitfaden", hf_col3_l3: "Impressum", hf_col3_l4: "AGB",
  hf_col4_t: "Partnerschaft",
  footer_partner_s: "Eine Idee für ein maßgeschneidertes Tool für Ihr Geschäft? Schreiben Sie uns.",
  hf_legal: "Etwas wird von Empire Donko (TransTech Dynamic), Benin, herausgegeben — im Übergang zu DONKO UG (Deutschland). Die genaue verantwortliche Einheit finden Sie im Impressum.",
  hf_brand: "ETWAS", hf_tagline: "Own Your Commerce.", powered_by: "Bereitgestellt von"
};

function applyHomeI18n(lang){
  var dict = HOME_I18N[lang];
  document.querySelectorAll("#etwasHome [data-i18n]").forEach(function(el){
    var key = el.getAttribute("data-i18n");
    if(lang === "fr" || !dict || !dict[key]){
      return; // le français est déjà le texte natif écrit dans le HTML
    }
    el.innerHTML = dict[key];
  });
  var footerLabel = $("footerLangLabel");
  if(footerLabel) footerLabel.textContent = lang === "fr" ? "Français" : (lang === "de" ? "Deutsch" : "English");
}

/* ---- Navigation interne (boutons data-goto de la page d'accueil) ---- */
function initHomeNavigation(){
  document.querySelectorAll("#etwasHome [data-goto]").forEach(function(btn){
    btn.addEventListener("click", function(){ showTab(btn.dataset.goto); });
  });
  var guideBtn = $("footLegalGuide"), mentionsBtn = $("footLegalMentions"), cguBtn = $("footLegalCgu");
  function openModuleLegal(key){
    // Le guide/mentions légales vivent dans les modules eux-mêmes (déjà
    // traduits en FR/EN/DE) — on bascule sur Etwas Pro et on lui demande
    // d'ouvrir directement la bonne fenêtre légale.
    showTab("kalcul");
    setTimeout(function(){
      if(frames.kalcul) try{ frames.kalcul.contentWindow.postMessage({type:"etwas:open-legal", key: key}, "*"); }catch(e){}
    }, 200);
  }
  if(guideBtn) guideBtn.addEventListener("click", function(){ openModuleLegal("guide"); });
  if(mentionsBtn) mentionsBtn.addEventListener("click", function(){ openModuleLegal("mentions"); });
  if(cguBtn) cguBtn.addEventListener("click", function(){ openModuleLegal("cgu"); });
}

/* ---- Boîtes boostées : pont depuis Etwas ADS (aucun fetch dupliqué ici —
   le shell se contente d'écouter ce que le module a déjà chargé). ---- */
function renderBoostedHome(list){
  var grid = $("homeBoostedGrid");
  var empty = $("homeBoostedEmpty");
  if(!grid) return;
  if(!list || !list.length){
    if(empty) empty.style.display = "block";
    return;
  }
  if(empty) empty.style.display = "none";
  grid.innerHTML = list.slice(0, 12).map(function(b){
    var img = b.logo || "icon-192.png";
    return '<button type="button" class="home-boosted-card" data-shop="' + (b.id||"") + '">' +
      '<img src="' + img + '" alt="' + (b.nom||"") + '" loading="lazy">' +
      '<div class="bc-body"><div class="bc-cat">' + (b.categorie||"") + '</div><div class="bc-name">' + (b.nom||"") + '</div></div>' +
    '</button>';
  }).join("");
  Array.prototype.forEach.call(grid.querySelectorAll("[data-shop]"), function(el){
    el.addEventListener("click", function(){
      showTab("marketplace");
      if(frames.marketplace) try{ frames.marketplace.contentWindow.postMessage({type:"etwas:open-shop", id: el.dataset.shop}, "*"); }catch(e){}
    });
  });
}

/* ---- Actualités datées : chaque entrée n'apparaît qu'à partir de sa date
   de publication — ajoute une entrée tous les ~30 jours pour que la
   section se renouvelle "automatiquement" sans toucher au reste du site. ---- */
var HOME_NEWS = [
  { date: "2026-09-12", fr: { t: "Lancement de la fusion Etwas Pro × Etwas ADS", d: "Les deux applications historiques, Kalcul Pro et DONKO ADS, deviennent officiellement Etwas Pro et Etwas ADS, réunies dans un seul shell installable, avec un compte et un paiement uniques pour les deux." },
    en: { t: "Launch of the Etwas Pro × Etwas ADS merger", d: "The two historical apps, Kalcul Pro and DONKO ADS, officially become Etwas Pro and Etwas ADS, unified in a single installable shell, with one account and one payment for both." },
    de: { t: "Start der Fusion Etwas Pro × Etwas ADS", d: "Die beiden bisherigen Apps, Kalcul Pro und DONKO ADS, werden offiziell zu Etwas Pro und Etwas ADS, vereint in einer installierbaren Shell mit einem gemeinsamen Konto und einer gemeinsamen Zahlung." } },
  { date: "2026-09-12", fr: { t: "Scan code-barre et Achat Express 1-Clic", d: "Etwas Pro peut désormais scanner un code-barre à la caméra pour ajouter un produit au panier ; Etwas ADS propose un bouton d'achat express qui prépare un message WhatsApp complet en un tap." },
    en: { t: "Barcode scan and 1-Click Express Purchase", d: "Etwas Pro can now scan a barcode with the camera to add a product to the cart; Etwas ADS offers an express purchase button that prepares a complete WhatsApp message in one tap." },
    de: { t: "Barcode-Scan und 1-Klick-Express-Kauf", d: "Etwas Pro kann jetzt einen Barcode mit der Kamera scannen, um ein Produkt zum Warenkorb hinzuzufügen; Etwas ADS bietet einen Express-Kauf-Button, der mit einem Tap eine vollständige WhatsApp-Nachricht vorbereitet." } }
];
function renderHomeNews(lang){
  var list = $("homeNewsList");
  if(!list) return;
  var now = new Date();
  var visible = HOME_NEWS.filter(function(n){ return new Date(n.date) <= now; })
    .sort(function(a,b){ return new Date(b.date) - new Date(a.date); });
  var loc = lang === "fr" ? "fr-FR" : (lang === "de" ? "de-DE" : "en-US");
  list.innerHTML = visible.map(function(n){
    var c = n[lang] || n.fr;
    return '<div class="home-news-item"><span class="home-news-date">' + new Date(n.date).toLocaleDateString(loc, {year:"numeric",month:"long",day:"numeric"}) + '</span>' +
      '<h3>' + c.t + '</h3><p>' + c.d + '</p></div>';
  }).join("");
}

function initHomeEngine(){
  applyHomeI18n(activeHomeLang);
  renderHomeNews(activeHomeLang);
  initHomeNavigation();
}
var activeHomeLang = "fr";

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
/* ----------------------------------------------------------
   Démarrage : le logo pulse et "ETWAS" s'écrit en boucle pendant
   au moins BOOT_MIN_MS (dans la fourchette demandée de 3 à 5
   secondes), même si les deux modules chargent plus vite que ça —
   c'est un moment de marque, pas juste un indicateur d'attente.
   Si le chargement dépasse ce minimum, l'écran se retire dès que
   les deux iframes sont prêtes (jamais plus de BOOT_MAX_MS, filet
   de sécurité en cas de connexion très lente).
   ---------------------------------------------------------- */
var BOOT_MIN_MS = 3500;
var BOOT_MAX_MS = 6000;
var bootTypewriterTimer = null;

function startBootTypewriter(){
  var word = "ETWAS";
  var el = $("bootTypeText");
  if(!el) return;
  var i = 0, deleting = false;

  function tick(){
    el.textContent = word.slice(0, i);
    if(!deleting){
      if(i < word.length){
        i++;
        bootTypewriterTimer = setTimeout(tick, 160);
      } else {
        // Mot complet affiché : petite pause avant de l'effacer.
        bootTypewriterTimer = setTimeout(function(){ deleting = true; tick(); }, 700);
      }
    } else {
      if(i > 0){
        i--;
        bootTypewriterTimer = setTimeout(tick, 90);
      } else {
        deleting = false;
        bootTypewriterTimer = setTimeout(tick, 300);
      }
    }
  }
  tick();
}
function stopBootTypewriter(){
  if(bootTypewriterTimer) clearTimeout(bootTypewriterTimer);
  bootTypewriterTimer = null;
}

function initBoot(){
  var bootStart = Date.now();
  startBootTypewriter();

  var pending = 2;
  var alreadyHidden = false;
  function hideBootNow(){
    if(alreadyHidden) return;
    alreadyHidden = true;
    stopBootTypewriter();
    var boot = $("etwasBoot");
    if(boot) boot.classList.add("etwas-hidden");
  }
  function ready(){
    pending -= 1;
    if(pending > 0) return;
    var elapsed = Date.now() - bootStart;
    if(elapsed >= BOOT_MIN_MS){
      hideBootNow();
    } else {
      setTimeout(hideBootNow, BOOT_MIN_MS - elapsed);
    }
  }
  frames.kalcul.addEventListener("load", ready, {once:true});
  frames.marketplace.addEventListener("load", ready, {once:true});
  // Filet de sécurité : si un module met trop de temps (connexion très lente
  // au tout premier chargement), on ne bloque pas l'utilisateur indéfiniment.
  setTimeout(hideBootNow, BOOT_MAX_MS);
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

function eurFmt(fcfa){
  var eur = fcfa / FCFA_PER_EUR;
  return "≈ " + eur.toLocaleString("fr-FR", {minimumFractionDigits:2, maximumFractionDigits:2}) + " €";
}
function renderPayPlans(){
  var grid = $("payPlansGrid");
  if(!grid) return;
  grid.innerHTML = PAY_PLANS.map(function(p){
    return '<div class="pay-plan' + (p.id===selectedPayPlan.id ? ' selected' : '') + '" data-id="' + p.id + '">' +
      (p.badge ? '<span class="pp-badge">' + p.badge + '</span>' : '') +
      '<div class="pp-label">' + p.label + '</div>' +
      (p.old ? '<span class="pp-old">' + fcfaFmt(p.old) + '</span>' : '') +
      '<span class="pp-new">' + fcfaFmt(p.priceNew) + '</span>' +
      '<div class="pp-eur">' + eurFmt(p.priceNew) + '</div>' +
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
  initHomeEngine();
  initShellLangTheme();
  updateConnStatus();
  window.addEventListener("online", updateConnStatus);
  window.addEventListener("offline", updateConnStatus);
}

/* ----------------------------------------------------------
   Langue et thème GLOBAUX — c'est ici, et UNIQUEMENT ici (page
   d'accueil du shell), que vivent ces deux réglages au niveau de
   toute l'application. Le choix se diffuse aux deux modules via le
   pont postMessage déjà existant (etwas:set-lang / etwas:set-theme),
   et s'applique aussi à la page d'accueil elle-même.
   ---------------------------------------------------------- */
function initShellLangTheme(){
  var langBtn = $("shellLangBtn");
  var themeBtn = $("shellThemeBtn");
  var footerLangBtn = $("footerLangBtn");
  var order = ["fr", "en", "de"];

  function setLang(lang){
    activeHomeLang = lang;
    if(langBtn) langBtn.textContent = lang.toUpperCase();
    applyHomeI18n(lang);
    renderHomeNews(lang);
    updateSlogan(lang);
    broadcastToOthers(null, {type:"etwas:set-lang", lang: lang});
  }
  function cycleLang(){
    setLang(order[(order.indexOf(activeHomeLang) + 1) % order.length]);
  }
  if(langBtn) langBtn.addEventListener("click", cycleLang);
  if(footerLangBtn) footerLangBtn.addEventListener("click", cycleLang);

  function setTheme(theme){
    document.documentElement.setAttribute("data-theme", theme);
    if(themeBtn) themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
    try{ localStorage.setItem("etwas_shell_theme", theme); }catch(e){}
    broadcastToOthers(null, {type:"etwas:theme-changed", theme: theme});
  }
  if(themeBtn){
    themeBtn.addEventListener("click", function(){
      var current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      setTheme(current === "dark" ? "light" : "dark");
    });
  }
  var savedTheme = null;
  try{ savedTheme = localStorage.getItem("etwas_shell_theme"); }catch(e){}
  if(savedTheme === "dark") setTheme("dark");
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
