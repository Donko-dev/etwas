/**
 * data.js — Configuration de la page Admin DONKO ADS
 * ----------------------------------------------------
 * Ce fichier est volontairement SÉPARÉ de admin.html : vous pouvez changer
 * l'URL Apps Script ou le code pro sans jamais toucher au code de la page.
 *
 * ⚠️ Ce fichier ne doit JAMAIS être téléversé sur GitHub à côté du site
 * public (index.html). Gardez-le uniquement sur votre ordinateur/téléphone,
 * dans le même dossier que admin.html, pour un usage local.
 *
 * IMPORTANT — à propos de la sécurité réelle :
 * Le "code pro" ci-dessous n'est pas stocké en clair (seule son empreinte
 * SHA-256 figure ici), et cette page ne peut RIEN modifier toute seule : elle
 * ne fait qu'envoyer vos actions à Google Apps Script, qui revérifie
 * lui-même ce code avant chaque action sensible (désactiver, supprimer,
 * accorder un accès...). C'est CETTE vérification côté serveur qui protège
 * réellement vos données — la page locale n'est qu'une interface pratique.
 * Aucune page HTML, aussi "chiffrée" soit-elle, ne peut cacher indéfiniment
 * un secret à quelqu'un qui a accès au fichier lui-même ; la vraie barrière
 * de sécurité est donc bien le serveur (Apps Script), pas ce fichier.
 */
const ADMIN_CONFIG = {
  // Doit être EXACTEMENT la même URL que CONFIG.APPS_SCRIPT_URL dans index.html.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbym5b-OU2061a_lqpRduCgQjHOF1f6fZXqtqY_L4KbdWCocOY5K_fAQNexDsMdQZtlf/exec',

  // Doit être EXACTEMENT la même empreinte que ADMIN_PASSCODE_HASH dans
  // AppsScript_v5.gs (côté serveur). Si vous changez le code pro, recalculez
  // son SHA-256 et remplacez CETTE valeur ici ET dans AppsScript_v5.gs, puis
  // redéployez une nouvelle version du script.
  ADMIN_PASSCODE_HASH: '391a9dc924d6b2a6fde451b85559d328ad52c8f4013f02d94d48e64d7a460e1a'
};
