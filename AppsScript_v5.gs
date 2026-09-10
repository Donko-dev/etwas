/**
 * DONKO ADS — Backend (Google Apps Script) — VERSION CORRIGÉE (bug d'enregistrement) + TVA + MODÉRATION
 * -------------------------------------------------------------------------------------------------
 * ⭐ CORRECTIF IMPORTANT DE CETTE VERSION — CAUSE RÉELLE DU BUG DE SAUVEGARDE
 *   Le fichier précédent envoyait TOUJOURS, à chaque modification d'annonce,
 *   des champs "optionnels" (PrixPromo, MasquerBoutique, CollecterAdresse,
 *   Slug, FaqJson, SeoKeywords) — même quand vous ne touchiez que la couleur
 *   ou le gras du texte. Or la fonction d'écriture (_col) plantait
 *   IMMÉDIATEMENT et annulait TOUTE la sauvegarde dès qu'UNE seule de ces
 *   colonnes n'existait pas encore dans votre Google Sheet (elles n'avaient
 *   jamais été demandées dans les instructions d'installation !). C'est
 *   exactement l'« erreur de connexion » que vous voyiez.
 *   → Correction : les champs optionnels utilisent désormais une écriture
 *   TOLÉRANTE (_colOptional) : si la colonne n'existe pas, ce champ précis
 *   est simplement ignoré, mais TOUT LE RESTE (description, couleur, gras,
 *   images, prix, contact...) s'enregistre normalement, sans jamais bloquer
 *   la sauvegarde entière. Ajoutez les colonnes ci-dessous quand vous le
 *   pouvez pour profiter de toutes les fonctionnalités, mais ce n'est plus
 *   obligatoire pour que le reste fonctionne.
 *
 * ⭐ NOUVEAU : TVA INTERNATIONALE AUTOMATIQUE SUR L'ABONNEMENT
 *   Le prix HT (hors taxe) de chaque forfait est défini une seule fois dans
 *   MARKETPLACE_PRICING_HT ci-dessous. Au moment de payer, le frontend
 *   demande à ce script (action "calculateVat") le montant TTC pour le pays
 *   choisi ; ce script consulte COUNTRY_VAT_RATES (Bénin/UEMOA, CEMAC, Union
 *   Européenne via le régime OSS, etc. — 0% par défaut si le pays n'est pas
 *   listé), calcule TVA = HT × taux, puis TTC = HT + TVA (arrondi à l'entier
 *   supérieur), et c'est ce TTC qui est réellement facturé via Kkiapay.
 *   Une fois le paiement vérifié, une ligne comptable exacte est ajoutée
 *   automatiquement dans un onglet "Comptabilite" (créé tout seul s'il
 *   n'existe pas encore) : Vendeur | Forfait | Pays | Montant HT | Taux TVA
 *   (%) | Montant TVA | Total TTC — pour vos déclarations (DGI au Bénin,
 *   fisc européen via OSS, etc.). Ce n'est PAS un conseil fiscal : faites
 *   valider les taux et le régime applicable par un comptable/fiscaliste
 *   avant toute déclaration réelle, en particulier pour l'UE (seuil OSS),
 *   les États-Unis (taxe de vente = par État, pas par pays — non gérée ici
 *   automatiquement) et l'Asie/Océanie (GST/TPS, très variable).
 *
 * ⭐ SUPPRESSION DE LA FONCTIONNALITÉ VIDÉO
 *   Les vendeurs ne peuvent plus envoyer de vidéo produit (Cloudinary
 *   retiré) ; seules les photos, la description et les informations produit
 *   restent. La colonne "VideosJson" existante dans votre Sheet peut rester
 *   telle quelle (elle ne sera plus jamais remplie) ou être supprimée
 *   manuellement, à votre convenance — ni l'un ni l'autre ne casse rien.
 *
 * MODÉRATION (inchangé) : désactiver/réactiver/supprimer une boutique ou une
 * annonce avec un message, réservé au code pro (voir plus bas dans ce fichier).
 *
 * INSTALLATION / COLONNES REQUISES
 * ---------------------------------
 * Colonnes INDISPENSABLES (sans elles, une erreur claire s'affichera) :
 *   Onglet "Boutiques" (A→P) :
 *     ID | Date | Nom | Categorie | Pays | Ville | Adresse | Contact |
 *     Description | Devise | Logo | Boost | BoostExpiration | OwnerToken |
 *     Suspendue | RaisonSuspension
 *   Onglet "Annonces" (A→T) :
 *     ID | BoutiqueID | Date | Lien | Description | Prix | PrixMode | Contact |
 *     Image1 | Image2 | Image3 | Image4 | VideoURL | Plan | PlanWeight |
 *     Expiration | TxnId | OwnerToken | Suspendue | RaisonSuspension
 *
 * Colonnes OPTIONNELLES pour "Annonces" (ajoutez-les quand vous voulez, dans
 * n'importe quel ordre, à la suite des colonnes existantes — si l'une d'elles
 * manque, la fonctionnalité correspondante est simplement ignorée, rien ne casse) :
 *     Image5 | Image6 | Image7 | Image8 | Image9 | Image10 | PrixPromo |
 *     MasquerBoutique | CollecterAdresse | Slug | FaqJson | SeoKeywords
 *
 * L'onglet "Comptabilite" (pour la TVA) est créé AUTOMATIQUEMENT par ce
 * script au premier abonnement payé — vous n'avez rien à faire pour lui.
 *
 * Étapes générales :
 * 1. Extensions > Apps Script → collez tout ce fichier (remplacez le code existant).
 * 2. ⚙️ Paramètres du projet > Propriétés du script : ajoutez KKIAPAY_PUBLIC_KEY,
 *    KKIAPAY_PRIVATE_KEY, KKIAPAY_SECRET_KEY.
 * 3. Déployer > Gérer les déploiements > crayon (modifier) > Nouvelle version > Déployer.
 *    (L'URL /exec ne change pas ; pas besoin de la recopier dans index.html.)
 */

const SHEET_BOUTIQUES = 'Boutiques';
const SHEET_ANNONCES = 'Annonces';

const HEADERS_BOUTIQUES = ['ID','Date','Nom','Categorie','Pays','Ville','Adresse','Contact','Description','Devise','Logo','Boost','BoostExpiration','OwnerToken','Suspendue','RaisonSuspension','Latitude','Longitude'];
const HEADERS_ANNONCES = ['ID','BoutiqueID','Date','Lien','Description','Prix','PrixMode','Contact',
  'Image1','Image2','Image3','Image4','VideoURL','Plan','PlanWeight','Expiration','TxnId','OwnerToken','Suspendue','RaisonSuspension',
  'Image5','Image6','Image7','Image8','Image9','Image10',
  'PrixPromo','MasquerBoutique','CollecterAdresse','Slug','FaqJson','SeoKeywords','VideosJson'];

// ⚠️ Doit rester STRICTEMENT identique à ADMIN_PASSCODE_HASH dans index.html.
// Si vous changez le code pro dans index.html, changez cette même valeur ici
// (recalculez le SHA-256 du nouveau code) puis redéployez une nouvelle version.
const ADMIN_PASSCODE_HASH = '391a9dc924d6b2a6fde451b85559d328ad52c8f4013f02d94d48e64d7a460e1a';

// Forcé sur VOTRE classeur exact, peu importe comment ce script a été créé
// (attaché ou non à un Sheet) — plus fiable que getActiveSpreadsheet().
const SPREADSHEET_ID = '1QwCS0tW7rhh97UogLRyDI93XOQu0Bqh3rSIQh0AENi8';

// ⚠️ Ces 3 clés doivent être ajoutées dans Apps Script → ⚙️ Paramètres du
// projet → Propriétés du script : KKIAPAY_PUBLIC_KEY, KKIAPAY_PRIVATE_KEY,
// KKIAPAY_SECRET_KEY. Rien n'est codé en dur ici, pour qu'aucune des trois
// ne soit jamais visible dans le fichier lui-même.
const KKIAPAY_API_BASE = 'https://api.kkiapay.me';

// Interroge Kkiapay pour savoir si une transaction a RÉELLEMENT eu lieu,
// avant de faire confiance à ce que prétend le navigateur du client.
// Distingue volontairement deux types d'échec, pour ne jamais les confondre :
//  - "verification_unavailable: ..." = problème technique (clé manquante,
//    réseau, adresse incorrecte) → PAS la faute du client, peut avoir vraiment payé.
//  - toute autre erreur = le paiement lui-même n'est pas valide/confirmé.
function _kkiapayVerify(transactionId){
  const props = PropertiesService.getScriptProperties();
  const publicKey = props.getProperty('KKIAPAY_PUBLIC_KEY');
  const privateKey = props.getProperty('KKIAPAY_PRIVATE_KEY');
  const secretKey = props.getProperty('KKIAPAY_SECRET_KEY') || '';
  if(!publicKey || !privateKey){
    throw new Error('verification_unavailable: clés Kkiapay absentes des propriétés du script.');
  }
  let res;
  try{
    res = UrlFetchApp.fetch(KKIAPAY_API_BASE + '/api/v1/transactions/status', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Accept': 'application/json',
        'X-API-KEY': publicKey,
        'X-PRIVATE-KEY': privateKey,
        'X-SECRET-KEY': secretKey
      },
      payload: JSON.stringify({ transactionId: String(transactionId) }),
      muteHttpExceptions: true
    });
  } catch(networkErr){
    throw new Error('verification_unavailable: ' + networkErr.toString());
  }
  const code = res.getResponseCode();
  if(code >= 400){
    throw new Error('verification_unavailable: Kkiapay a répondu avec le code ' + code + '.');
  }
  let parsed;
  try{ parsed = JSON.parse(res.getContentText()); }
  catch(parseErr){ throw new Error('verification_unavailable: réponse Kkiapay illisible.'); }
  return parsed;
}
function _ss(){ return SpreadsheetApp.openById(SPREADSHEET_ID); }
function _sheetBoutiques(){ return _ss().getSheetByName(SHEET_BOUTIQUES); }
function _sheetAnnonces(){ return _ss().getSheetByName(SHEET_ANNONCES); }

function _json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function _rowsToObjects(values){
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(cell => cell !== ''))
    .map(row => { const o = {}; headers.forEach((h,i)=>{ o[h]=row[i]; }); return o; });
}
function _findRowIndexById(values, id){
  const idCol = values[0].indexOf('ID');
  for (let r = 1; r < values.length; r++) if (values[r][idCol] === id) return r;
  return -1;
}

// Compare les en-têtes en ignorant espaces et majuscules/minuscules, pour
// tolérer les petites variations de frappe (ex: "Video URL" ou "videourl"
// seront reconnus comme "VideoURL") sans jamais planter pour si peu.
function _normalizeHeader(s){
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

// Retrouve la position d'une colonne par son en-tête (tolérant aux espaces/
// majuscules), et échoue avec un message clair et exploitable si elle est
// vraiment introuvable — plutôt qu'un plantage cryptique de Google Sheets
// ("colonne 0 invalide") qui ne dit pas quoi corriger.
function _col(headers, name){
  const target = _normalizeHeader(name);
  const idx = headers.findIndex(h => _normalizeHeader(h) === target);
  if(idx === -1){
    throw new Error('Colonne "' + name + '" introuvable dans la feuille — vérifiez qu\u2019un en-tête de ce type existe en ligne 1 (l\u2019orthographe exacte n\u2019a plus besoin d\u2019être parfaite, mais le mot doit être présent).');
  }
  return idx + 1;
}

// Version TOLÉRANTE de _col() : renvoie -1 au lieu de lever une erreur quand
// la colonne n'existe pas. Réservée aux champs OPTIONNELS (fonctionnalités
// récentes) afin qu'une colonne manquante n'annule jamais la sauvegarde des
// champs essentiels (description, images, prix, contact...) qui l'accompagnent
// dans la même requête. C'est le correctif du bug « erreur de connexion » /
// « la modification ne s'enregistre pas » signalé sur les annonces.
function _colOptional(headers, name){
  const target = _normalizeHeader(name);
  const idx = headers.findIndex(h => _normalizeHeader(h) === target);
  return idx === -1 ? -1 : idx + 1;
}

/* ================== TVA INTERNATIONALE ================== */

// Prix de base HORS TAXE (HT) de chaque forfait, en Francs CFA (XOF).
// Les identifiants correspondent exactement à ceux utilisés par le frontend
// (PLANS dans index.html) : mensuel, bimestriel, trimestriel, semestriel,
// annuel, 2ans, 3ans, avie.
const MARKETPLACE_PRICING_HT = {
  // Essai complet : prix plancher symbolique fixe (1€ ≈ 656 FCFA, parité
  // fixe UEMOA/CEMAC), volontairement exempté de la TVA pays par pays
  // dans _computeVat ci-dessous — sinon le montant réel dépasserait 1€.
  trial:       { nom: 'Essai complet', prixHT: 656 },
  mensuel:     { nom: 'Mensuel',     prixHT: 10838 },
  bimestriel:  { nom: 'Bimestriel',  prixHT: 19465 },
  trimestriel: { nom: 'Trimestriel', prixHT: 27115 },
  semestriel:  { nom: 'Semestriel',  prixHT: 48875 },
  annuel:      { nom: 'Annuel',      prixHT: 80750 },
  '2ans':      { nom: '2 ans',       prixHT: 135150 },
  '3ans':      { nom: '3 ans',       prixHT: 177650 },
  avie:        { nom: 'À vie',       prixHT: 403750 }
};

// Taux de TVA par pays (identifiants alignés sur COUNTRIES dans index.html).
// Valeur par défaut si le pays n'est pas listé : 0 %. Ceci est une base de
// départ raisonnable, PAS un avis fiscal définitif — faites valider les taux
// réels par un comptable avant toute déclaration, en particulier pour les
// régimes qui dépendent d'un seuil de chiffre d'affaires (OSS européen) ou
// d'une subdivision infra-nationale (taxe de vente américaine par État,
// GST/TPS variable en Asie-Océanique).
const COUNTRY_VAT_RATES = {
  // UEMOA (Afrique de l'Ouest, TVA communautaire ~18 %)
  bj:18, tg:18, ci:18, sn:18, ne:18, ml:18, bf:18, gw:18,
  // CEMAC (Afrique Centrale, TVA généralement 19,25 % — simplifié à 19 %)
  cm:19, ga:19, cg:19, cd:16, td:18, cf:19, gq:15,
  // Autres pays africains avec TVA connue
  gn:18, gh:15, ng:7.5, ma:20, dz:19, tn:19, eg:14, ke:16, tz:18, ug:18,
  rw:18, za:15, zw:14.5, zm:16, mz:16, ao:14, mu:15, mg:20,
  // Union Européenne (régime OSS pour les prestations numériques B2C)
  fr:20, de:19, be:21, ch:8.1, lu:17, es:21, pt:23, it:22, gb:20, ie:23,
  nl:21, at:20, se:25, no:25, dk:25, fi:24, pl:23, gr:24, ro:19, cz:21,
  hu:27, hr:25,
  // Amériques (taxe fédérale/nationale simplifiée — hors taxes d'État US)
  ca:5, mx:16, br:17, ar:21, cl:19, co:19, pe:18,
  // Asie-Océanique
  cn:13, jp:10, kr:10, in:18, id:11, my:6, sg:9, th:7, vn:10, ph:12,
  au:10, nz:15, ae:5, sa:15, tr:20, il:17
};

function _vatRateForCountry(countryId){
  const id = String(countryId||'').toLowerCase().trim();
  const rate = COUNTRY_VAT_RATES[id];
  return (typeof rate === 'number') ? rate : 0;
}

// Calcule la ventilation HT / TVA / TTC pour un forfait et un pays donnés.
// Le TTC est TOUJOURS arrondi à l'entier CFA supérieur (Math.ceil), jamais
// tronqué, pour ne jamais sous-facturer la TVA réellement due.
function _computeVat(planId, countryId){
  const plan = MARKETPLACE_PRICING_HT[planId];
  if(!plan) throw new Error('Forfait inconnu : ' + planId);
  if(planId === 'trial'){
    // Offre d'appel à prix fixe : pas de TVA ajoutée, le prix affiché
    // (1€ / 656 FCFA) est le prix réellement facturé, dans tous les pays.
    return { plan: planId, nomPlan: plan.nom, pays: countryId||'', prixHT: plan.prixHT, tauxTVA: 0, montantTVA: 0, totalTTC: plan.prixHT };
  }
  const tauxTVA = _vatRateForCountry(countryId);
  const prixHT = plan.prixHT;
  const montantTVA = Math.ceil(prixHT * (tauxTVA/100));
  const totalTTC = prixHT + montantTVA;
  return { plan: planId, nomPlan: plan.nom, pays: countryId||'', prixHT, tauxTVA, montantTVA, totalTTC };
}

// Retrouve (ou crée, avec ses en-têtes) l'onglet de comptabilité TVA.
// Créé automatiquement dès le premier abonnement payé : aucune manipulation
// manuelle du classeur n'est nécessaire pour cette fonctionnalité.
const SHEET_COMPTA = 'Comptabilite';
const HEADERS_COMPTA = ['Date','ID Vendeur','Forfait','Pays Client','Montant HT','Taux TVA (%)','Montant TVA collecté','Total TTC Payé','TxnId'];
function _sheetCompta(){
  const ss = _ss();
  let sh = ss.getSheetByName(SHEET_COMPTA);
  if(!sh){
    sh = ss.insertSheet(SHEET_COMPTA);
    sh.appendRow(HEADERS_COMPTA);
    sh.getRange(1,1,1,HEADERS_COMPTA.length).setFontWeight('bold');
  }
  return sh;
}
function _logComptaRow(vendeurId, vatCalc, txnId){
  const sh = _sheetCompta();
  sh.appendRow([
    new Date(), vendeurId||'', vatCalc.nomPlan||vatCalc.plan||'', vatCalc.pays||'',
    vatCalc.prixHT, vatCalc.tauxTVA, vatCalc.montantTVA, vatCalc.totalTTC, txnId||''
  ]);
}

// Force une cellule à rester du texte brut, quel que soit son contenu.
// Sans ça, Google Sheets peut transformer un numéro commençant par "+" en
// #ERROR! (il l'interprète comme le début d'une formule) — y compris quand
// c'est ce script qui écrit la valeur, pas seulement en saisie manuelle.
// En fixant le format en "@" (texte) AVANT d'écrire la valeur, ce risque est
// éliminé définitivement, pour toujours, sans jamais dépendre d'un réglage
// manuel sur la feuille.
function _setTextValue(sheet, row, col, value){
  sheet.getRange(row, col).setNumberFormat('@').setValue(value);
}

/* ================== SÉCURITÉ : jeton propriétaire + code pro ================== */

// Calcule le SHA-256 d'une chaîne (même algorithme que côté navigateur en JS).
function _sha256Hex(text){
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text || ''), Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0')).join('');
}

// Vrai uniquement si le code pro envoyé par le client correspond réellement
// à l'empreinte enregistrée. C'est la SEULE vérification qui compte : celle
// affichée dans l'app n'est qu'un confort d'interface.
function _isAdminAuthorized(data){
  return !!data.adminSecret && _sha256Hex(data.adminSecret) === ADMIN_PASSCODE_HASH;
}

// Vrai si le jeton fourni par le client correspond au jeton enregistré sur la
// ligne (donc c'est bien l'appareil qui a créé cet élément), OU si la ligne
// est une ancienne ligne sans jeton (créée avant ce correctif — transition).
function _ownerAuthorized(row, headers, data){
  const tokenCol = headers.indexOf('OwnerToken');
  const storedToken = tokenCol > -1 ? row[tokenCol] : '';
  if(!storedToken) return true;
  return !!data.ownerToken && data.ownerToken === storedToken;
}

// Jeton propriétaire d'une boutique (utile pour vérifier qu'une annonce est
// bien publiée par le créateur de la boutique visée).
function _boutiqueOwnerToken(boutiqueId){
  const values = _sheetBoutiques().getDataRange().getValues();
  const r = _findRowIndexById(values, boutiqueId);
  if(r === -1) return null;
  const tokenCol = values[0].indexOf('OwnerToken');
  return tokenCol > -1 ? values[r][tokenCol] : '';
}

/* ================== doGet : lecture publique (inchangé) ================== */
function doGet(e) {
  const now = new Date();

  const boutiques = _rowsToObjects(_sheetBoutiques().getDataRange().getValues());
  let annonces = _rowsToObjects(_sheetAnnonces().getDataRange().getValues())
    .filter(a => !a.Expiration || new Date(a.Expiration) > now);

  const boutiquesById = {};
  boutiques.forEach(b => { boutiquesById[b.ID] = b; });
  annonces = annonces.map(a => {
    const b = boutiquesById[a.BoutiqueID] || {};
    const boutiqueSuspendue = !!b.Suspendue;
    const annonceSuspendue = !!a.Suspendue;
    const suspendue = boutiqueSuspendue || annonceSuspendue;
    // Si la boutique entière est désactivée, sa raison prime sur celle,
    // éventuellement différente, d'une annonce individuelle.
    const raison = boutiqueSuspendue ? (b.RaisonSuspension || '') : (annonceSuspendue ? (a.RaisonSuspension || '') : '');
    return Object.assign({}, a, {
      BoutiqueNom: b.Nom || '', Categorie: b.Categorie || '', Pays: b.Pays || '',
      Ville: b.Ville || '', BoutiqueLogo: b.Logo || '', BoutiqueDevise: b.Devise || 'XOF',
      // Coordonnées PUBLIQUES de la boutique (jamais celles de l'acheteur) —
      // permettent au client de calculer localement (Haversine) la distance
      // à laquelle se trouve chaque annonce, sans qu'aucune coordonnée de
      // l'acheteur ne soit jamais transmise à ce serveur.
      BoutiqueLatitude: (b.Latitude !== '' && b.Latitude != null) ? Number(b.Latitude) : null,
      BoutiqueLongitude: (b.Longitude !== '' && b.Longitude != null) ? Number(b.Longitude) : null,
      Suspendue: suspendue, RaisonSuspension: raison
    });
  });

  const boutiquesBoostees = boutiques.filter(b => b.Boost && b.BoostExpiration && new Date(b.BoostExpiration) > now);

  return _json({ success: true, annonces: annonces, boutiques: boutiques, boutiquesBoostees: boutiquesBoostees });
}

/* ================== doPost : écriture ================== */
function doPost(e) {
  try {
    const data = e.parameter;
    switch (data.action) {
      case 'addBoutique':    return _addBoutique(data);
      case 'updateBoutique': return _updateBoutique(data);
      case 'deleteBoutique': return _deleteBoutique(data);
      case 'boostBoutique':  return _boostBoutique(data);
      case 'addAnnonce':     return _addAnnonce(data);
      case 'updateAnnonce':  return _updateAnnonce(data);
      case 'deleteAnnonce':  return _deleteAnnonce(data);
      case 'renew':          return _renewAnnonces(data);
      case 'calculateVat':   return _calculateVatAction(data);
      case 'confirmSubscription': return _confirmSubscription(data);
      case 'adminGrant':     return _adminGrant(data);
      case 'suspendBoutique':   return _suspendBoutique(data);
      case 'unsuspendBoutique': return _unsuspendBoutique(data);
      case 'suspendAnnonce':    return _suspendAnnonce(data);
      case 'unsuspendAnnonce':  return _unsuspendAnnonce(data);
      default: throw new Error('Action inconnue : ' + data.action);
    }
  } catch (err) {
    return _json({ success: false, error: err.toString() });
  }
}

/* ---------------- Boutiques ---------------- */
function _addBoutique(data){
  if(!data.name || !data.category) throw new Error('Nom ou catégorie manquant.');
  const sheet = _sheetBoutiques();
  const id = Utilities.getUuid();
  const row = HEADERS_BOUTIQUES.map(h => {
    switch(h){
      case 'ID': return id;
      case 'Date': return new Date();
      case 'Nom': return data.name || '';
      case 'Categorie': return data.category || '';
      case 'Pays': return data.country || '';
      case 'Ville': return data.city || '';
      case 'Adresse': return data.address || '';
      case 'Contact': return data.contact || '';
      case 'Description': return data.description || '';
      case 'Devise': return data.currency || 'XOF';
      case 'Logo': return data.logo || '';
      case 'Boost': return false;
      case 'BoostExpiration': return '';
      case 'OwnerToken': return data.ownerToken || '';
      case 'Suspendue': return false;
      case 'RaisonSuspension': return '';
      // Coordonnées de la boutique elle-même (publiques, affichées pour
      // permettre le filtre par distance) — jamais celles de l'acheteur,
      // qui restent strictement locales à son appareil (voir client).
      case 'Latitude': return (data.lat != null) ? Number(data.lat) : '';
      case 'Longitude': return (data.lng != null) ? Number(data.lng) : '';
      default: return '';
    }
  });
  sheet.appendRow(row);
  _setTextValue(sheet, sheet.getLastRow(), HEADERS_BOUTIQUES.indexOf('Contact')+1, data.contact || '');
  return _json({ success:true, id: id });
}

function _updateBoutique(data){
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetBoutiques();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Boutique introuvable.');
  const headers = values[0];
  if(!_ownerAuthorized(values[r], headers, data) && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette boutique ne vous appartient pas.');
  }
  const fieldMap = { name:'Nom', category:'Categorie', country:'Pays', city:'Ville', address:'Adresse',
    contact:'Contact', description:'Description', currency:'Devise', logo:'Logo', lat:'Latitude', lng:'Longitude' };
  Object.keys(fieldMap).forEach(key=>{
    if(typeof data[key] !== 'undefined'){
      const col = _col(headers, fieldMap[key]);
      if(key === 'contact'){ _setTextValue(sheet, r+1, col, data[key]); }
      else { sheet.getRange(r+1, col).setValue(data[key]); }
    }
  });
  return _json({ success:true });
}

function _deleteBoutique(data){
  if(!data.id) throw new Error('ID manquant.');
  const bSheet = _sheetBoutiques();
  const bValues = bSheet.getDataRange().getValues();
  const r = _findRowIndexById(bValues, data.id);
  if(r === -1) throw new Error('Boutique introuvable.');
  if(!_ownerAuthorized(bValues[r], bValues[0], data) && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette boutique ne vous appartient pas.');
  }
  bSheet.deleteRow(r+1);

  const aSheet = _sheetAnnonces();
  const aValues = aSheet.getDataRange().getValues();
  const boutiqueCol = aValues[0].indexOf('BoutiqueID');
  for(let i = aValues.length - 1; i >= 1; i--){
    if(aValues[i][boutiqueCol] === data.id) aSheet.deleteRow(i+1);
  }
  return _json({ success:true });
}

function _boostBoutique(data){
  if(!data.id || !data.boostExpiration) throw new Error('ID ou date de boost manquant.');
  const sheet = _sheetBoutiques();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Boutique introuvable.');
  const headers = values[0];
  if(!_ownerAuthorized(values[r], headers, data) && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette boutique ne vous appartient pas.');
  }
  sheet.getRange(r+1, _col(headers, 'Boost')).setValue(true);
  sheet.getRange(r+1, _col(headers, 'BoostExpiration')).setValue(data.boostExpiration);
  return _json({ success:true });
}

/* ---------------- Annonces ---------------- */
// Vérifie qu'un slug (URL personnalisée) n'est pas déjà utilisé par une autre
// annonce. excludeId permet à une annonce de conserver son propre slug lors
// d'une modification.
function _slugTaken(slug, excludeId){
  if(!slug) return false;
  const norm = String(slug).toLowerCase().trim();
  const values = _sheetAnnonces().getDataRange().getValues();
  const headers = values[0];
  const slugCol = headers.indexOf('Slug');
  const idCol = headers.indexOf('ID');
  if(slugCol === -1) return false;
  for(let r = 1; r < values.length; r++){
    if(values[r][idCol] === excludeId) continue;
    if(String(values[r][slugCol]||'').toLowerCase().trim() === norm) return true;
  }
  return false;
}

function _addAnnonce(data){
  if(!data.boutiqueId || !data.description) throw new Error('Boutique ou description manquante.');
  const shopToken = _boutiqueOwnerToken(data.boutiqueId);
  if(shopToken === null) throw new Error('Boutique introuvable.');
  if(shopToken && shopToken !== data.ownerToken && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette boutique ne vous appartient pas.');
  }
  if(data.slug && _slugTaken(data.slug, null)){
    throw new Error('Cette URL personnalisée est déjà utilisée par une autre annonce.');
  }
  const sheet = _sheetAnnonces();
  // On construit la ligne d'après les en-têtes RÉELLEMENT présents dans la
  // feuille (et non d'après HEADERS_ANNONCES, qui décrit le maximum possible
  // de fonctionnalités) : si une colonne optionnelle n'existe pas encore chez
  // ce vendeur, on l'ignore simplement au lieu de désaligner ou de planter.
  const existingValues = sheet.getDataRange().getValues();
  const headers = existingValues[0];
  const id = Utilities.getUuid();
  const fieldsByHeader = {
    'ID': id,
    'BoutiqueID': data.boutiqueId,
    'Date': new Date(),
    'Lien': data.link || '',
    'Description': data.description || '',
    'Prix': data.price || '',
    'PrixMode': data.priceMode || 'nonbarre',
    'Contact': data.contact || '',
    'Image1': data.image1 || '',
    'Image2': data.image2 || '',
    'Image3': data.image3 || '',
    'Image4': data.image4 || '',
    'Image5': data.image5 || '',
    'Image6': data.image6 || '',
    'Image7': data.image7 || '',
    'Image8': data.image8 || '',
    'Image9': data.image9 || '',
    'Image10': data.image10 || '',
    'VideoURL': '', // fonctionnalité vidéo retirée ; colonne laissée vide si présente
    'Plan': data.plan || '',
    'PlanWeight': Number(data.planWeight) || 0,
    'Expiration': data.expiry || '',
    'TxnId': data.txnId || '',
    'OwnerToken': data.ownerToken || '',
    'Suspendue': false,
    'RaisonSuspension': '',
    'PrixPromo': data.pricePromo || '',
    'MasquerBoutique': data.hideFromShop === 'true' || data.hideFromShop === true,
    'CollecterAdresse': data.collectAddress === 'true' || data.collectAddress === true,
    'Slug': (data.slug || '').toLowerCase(),
    'FaqJson': data.faqJson || '',
    'SeoKeywords': data.seoKeywords || ''
  };
  const row = headers.map(h=>{
    const norm = _normalizeHeader(h);
    const key = Object.keys(fieldsByHeader).find(k => _normalizeHeader(k) === norm);
    return key ? fieldsByHeader[key] : '';
  });
  sheet.appendRow(row);
  const contactCol = _colOptional(headers, 'Contact');
  if(contactCol > -1) _setTextValue(sheet, sheet.getLastRow(), contactCol, data.contact || '');
  return _json({ success:true, id: id });
}

function _updateAnnonce(data){
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Annonce introuvable.');
  const headers = values[0];
  if(!_ownerAuthorized(values[r], headers, data) && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette annonce ne vous appartient pas.');
  }
  if(data.slug && _slugTaken(data.slug, data.id)){
    throw new Error('Cette URL personnalisée est déjà utilisée par une autre annonce.');
  }
  // Champs ESSENTIELS : garantis présents depuis la toute première version de
  // la feuille. S'ils manquent, c'est une vraie erreur d'installation qui
  // doit être signalée clairement (_col lève une exception explicite).
  const essentialFieldMap = { link:'Lien', description:'Description', price:'Prix', priceMode:'PrixMode',
    contact:'Contact', image1:'Image1', image2:'Image2', image3:'Image3', image4:'Image4' };
  Object.keys(essentialFieldMap).forEach(key=>{
    if(typeof data[key] !== 'undefined'){
      const col = _col(headers, essentialFieldMap[key]);
      if(key === 'contact'){ _setTextValue(sheet, r+1, col, data[key]); }
      else { sheet.getRange(r+1, col).setValue(data[key]); }
    }
  });

  // Champs OPTIONNELS (fonctionnalités ajoutées récemment) : si la colonne
  // n'existe pas encore dans la feuille de ce vendeur, on ignore SEULEMENT ce
  // champ précis — jamais toute la sauvegarde. C'est le correctif du bug où
  // changer la couleur/le gras du texte en même temps que les images faisait
  // échouer l'enregistrement complet avec une « erreur de connexion ».
  const optionalFieldMap = { image5:'Image5', image6:'Image6', image7:'Image7', image8:'Image8', image9:'Image9', image10:'Image10',
    pricePromo:'PrixPromo', hideFromShop:'MasquerBoutique', collectAddress:'CollecterAdresse',
    slug:'Slug', faqJson:'FaqJson', seoKeywords:'SeoKeywords' };
  Object.keys(optionalFieldMap).forEach(key=>{
    if(typeof data[key] === 'undefined') return;
    const col = _colOptional(headers, optionalFieldMap[key]);
    if(col === -1) return; // colonne absente : on ignore ce champ précis, sans bloquer le reste
    if(key === 'hideFromShop' || key === 'collectAddress'){ sheet.getRange(r+1, col).setValue(data[key]==='true'||data[key]===true); }
    else if(key === 'slug'){ sheet.getRange(r+1, col).setValue(String(data[key]).toLowerCase()); }
    else { sheet.getRange(r+1, col).setValue(data[key]); }
  });
  return _json({ success:true });
}

function _deleteAnnonce(data){
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Annonce introuvable.');
  const headers = values[0];
  if(!_ownerAuthorized(values[r], headers, data) && !_isAdminAuthorized(data)){
    throw new Error('Non autorisé : cette annonce ne vous appartient pas.');
  }
  sheet.deleteRow(r+1);
  return _json({ success:true });
}

// RÉSERVÉ AU CODE PRO désormais : ce n'est plus le chemin normal (voir
// _confirmSubscription plus bas, qui vérifie un vrai paiement). Cette
// fonction reste disponible uniquement pour une régularisation manuelle.
function _renewAnnonces(data){
  if(!_isAdminAuthorized(data)) throw new Error('Non autorisé : action réservée au code pro.');
  if(!data.ids) throw new Error('Aucune annonce à renouveler.');
  const idList = String(data.ids).split(',').filter(x=>x);
  if(!idList.length) throw new Error('Aucune annonce à renouveler.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const planCol = _col(headers, 'Plan'), weightCol = _col(headers, 'PlanWeight'), expCol = _col(headers, 'Expiration');
  let renewed = 0;
  idList.forEach(id=>{
    const r = _findRowIndexById(values, id);
    if(r !== -1){
      sheet.getRange(r+1, planCol).setValue(data.plan || '');
      sheet.getRange(r+1, weightCol).setValue(Number(data.planWeight) || 0);
      sheet.getRange(r+1, expCol).setValue(data.expiry || '');
      renewed++;
    }
  });
  return _json({ success:true, renewed: renewed });
}

// Appelée par le frontend juste avant d'ouvrir le widget Kkiapay : renvoie le
// montant TTC exact (HT + TVA du pays choisi) à facturer réellement. C'est ce
// montant, et lui seul, qui doit être transmis à openKkiapayWidget().
function _calculateVatAction(data){
  if(!data.plan) throw new Error('Forfait manquant.');
  const calc = _computeVat(data.plan, data.country);
  return _json(Object.assign({ success:true }, calc));
}

// ⭐ NOUVEAU : remplace la confiance aveugle envers le navigateur par une
// vraie vérification auprès de Kkiapay avant d'activer un abonnement.
// - Vérifie que la transaction existe vraiment et est un succès.
// - Vérifie que le montant payé correspond au plan choisi (pas un plan
//   moins cher détourné vers un plus cher).
// - Empêche de réutiliser deux fois le même numéro de transaction.
function _confirmSubscription(data){
  if(!data.txnId) throw new Error('Numéro de transaction manquant.');

  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const txnCol = headers.indexOf('TxnId');

  const alreadyUsed = values.slice(1).some(row => row[txnCol] && String(row[txnCol]) === String(data.txnId));
  if(alreadyUsed) throw new Error('Cette transaction a déjà été utilisée.');

  const verif = _kkiapayVerify(data.txnId);
  if(!verif || verif.status !== 'SUCCESS'){
    throw new Error('Paiement non confirmé par Kkiapay (statut : ' + (verif && verif.status || 'inconnu') + ').');
  }

  // Le montant réellement dû (HT + TVA du pays) est recalculé ICI, côté
  // serveur, à partir du forfait et du pays reçus — jamais déduit de ce que
  // le navigateur affirme avoir payé. Une marge d'1 F CFA tolère les écarts
  // d'arrondi entre affichage et calcul serveur, sans jamais permettre de
  // payer sciemment moins que le TTC dû.
  let vatCalc = null;
  if(data.plan && MARKETPLACE_PRICING_HT[data.plan]){
    vatCalc = _computeVat(data.plan, data.country);
    if(Number(verif.amount) < vatCalc.totalTTC - 1){
      throw new Error('Le montant payé (' + verif.amount + ') ne correspond pas au total TTC attendu (' + vatCalc.totalTTC + ') pour ce forfait et ce pays.');
    }
  } else if(data.expectedAmount){
    // Repli pour compatibilité (forfait hors table HT, ex. anciens plans) :
    // on retombe sur l'ancienne vérification par montant brut envoyé par le client.
    if(Number(verif.amount) < Number(data.expectedAmount)){
      throw new Error('Le montant payé ne correspond pas au plan choisi.');
    }
  } else {
    throw new Error('Impossible de vérifier le montant : forfait ou montant attendu manquant.');
  }

  // Paiement authentique : on renouvelle les annonces de cet appareil, et on
  // marque ce numéro de transaction pour empêcher toute réutilisation future.
  const idList = data.ids ? String(data.ids).split(',').filter(x=>x) : [];
  const planCol = _col(headers, 'Plan'), weightCol = _col(headers, 'PlanWeight'), expCol = _col(headers, 'Expiration');
  const isAdmin = _isAdminAuthorized(data);
  let renewed = 0;
  idList.forEach(id=>{
    const r = _findRowIndexById(values, id);
    if(r !== -1 && (isAdmin || _ownerAuthorized(values[r], headers, data))){
      sheet.getRange(r+1, planCol).setValue(data.plan || '');
      sheet.getRange(r+1, weightCol).setValue(Number(data.planWeight) || 0);
      sheet.getRange(r+1, expCol).setValue(data.expiry || '');
      sheet.getRange(r+1, txnCol+1).setValue(data.txnId);
      renewed++;
    }
  });

  // Ventilation comptable exacte (HT / taux / TVA collectée / TTC) pour la
  // déclaration fiscale — enregistrée uniquement quand un calcul TVA a réellement
  // eu lieu (forfait reconnu dans MARKETPLACE_PRICING_HT).
  if(vatCalc){
    const vendeurId = (idList[0] && data.ownerToken) ? data.ownerToken : (data.ownerToken || '');
    try{ _logComptaRow(vendeurId, vatCalc, data.txnId); }
    catch(logErr){ /* la comptabilité ne doit jamais faire échouer l'activation de l'accès déjà payé */ }
  }

  return _json({ success:true, renewed: renewed, verified: true, vat: vatCalc });
}

// Outil admin : accorder/modifier l'accès de n'importe quelle annonce depuis
// l'app. RÉSERVÉ AU CODE PRO — c'est la vérification qui manquait totalement
// avant ce correctif. Sans le bon code, cette action est désormais refusée.
function _adminGrant(data){
  if(!_isAdminAuthorized(data)){
    throw new Error('Non autorisé : code pro invalide ou manquant.');
  }
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Annonce introuvable.');
  const headers = values[0];
  if(data.expiry) sheet.getRange(r+1, _col(headers, 'Expiration')).setValue(data.expiry);
  if(data.plan) sheet.getRange(r+1, _col(headers, 'Plan')).setValue(data.plan);
  if(typeof data.planWeight !== 'undefined' && data.planWeight !== '') sheet.getRange(r+1, _col(headers, 'PlanWeight')).setValue(Number(data.planWeight));
  return _json({ success:true });
}

/* ---------------- Modération (réservé au code pro) ---------------- */
// Désactive une boutique ENTIÈRE avec un message. Toutes ses annonces
// afficheront ce message publiquement à la place de leur contenu normal,
// et le vendeur le verra dans "Mes boutiques".
function _suspendBoutique(data){
  if(!_isAdminAuthorized(data)) throw new Error('Non autorisé : code pro invalide ou manquant.');
  if(!data.id) throw new Error('ID manquant.');
  if(!data.reason) throw new Error('Raison manquante.');
  const sheet = _sheetBoutiques();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Boutique introuvable.');
  const headers = values[0];
  sheet.getRange(r+1, _col(headers, 'Suspendue')).setValue(true);
  sheet.getRange(r+1, _col(headers, 'RaisonSuspension')).setValue(data.reason);
  return _json({ success:true });
}
function _unsuspendBoutique(data){
  if(!_isAdminAuthorized(data)) throw new Error('Non autorisé : code pro invalide ou manquant.');
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetBoutiques();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Boutique introuvable.');
  const headers = values[0];
  sheet.getRange(r+1, _col(headers, 'Suspendue')).setValue(false);
  sheet.getRange(r+1, _col(headers, 'RaisonSuspension')).setValue('');
  return _json({ success:true });
}
// Même chose, mais pour UNE SEULE annonce (le reste de la boutique continue
// de s'afficher normalement).
function _suspendAnnonce(data){
  if(!_isAdminAuthorized(data)) throw new Error('Non autorisé : code pro invalide ou manquant.');
  if(!data.id) throw new Error('ID manquant.');
  if(!data.reason) throw new Error('Raison manquante.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Annonce introuvable.');
  const headers = values[0];
  sheet.getRange(r+1, _col(headers, 'Suspendue')).setValue(true);
  sheet.getRange(r+1, _col(headers, 'RaisonSuspension')).setValue(data.reason);
  return _json({ success:true });
}
function _unsuspendAnnonce(data){
  if(!_isAdminAuthorized(data)) throw new Error('Non autorisé : code pro invalide ou manquant.');
  if(!data.id) throw new Error('ID manquant.');
  const sheet = _sheetAnnonces();
  const values = sheet.getDataRange().getValues();
  const r = _findRowIndexById(values, data.id);
  if(r === -1) throw new Error('Annonce introuvable.');
  const headers = values[0];
  sheet.getRange(r+1, _col(headers, 'Suspendue')).setValue(false);
  sheet.getRange(r+1, _col(headers, 'RaisonSuspension')).setValue('');
  return _json({ success:true });
}
